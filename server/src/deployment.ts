import {
    DEPLOYMENT_STATUS, DEPLOYMENT_OBJECT_STATUS, DEPLOYMENT_OBJECT_ACTION, IDeploymentObject, IObject2, IDeploymentTrigger
} from '../../shared/state'
import { webClients, db, hostClients } from './instances'
import { ACTION, ISetDeploymentStatus, ISetDeploymentMessage, IToggleDeploymentObject, ISetDeploymentObjects, ISetDeploymentObjectStatus, IAddDeploymentLog, IClearDeploymentLog } from '../../shared/actions'
import { typeId, rootInstanceId, rootId, hostId, IVariables, IType, TypePropType, IDepends, ITriggers, ITrigger, ISudoOn, IContains } from '../../shared/type'
import * as PriorityQueue from 'priorityqueuejs'
import * as Mustache from 'mustache'
import { DeployJob } from './jobs/deployJob'
import { errorHandler } from './error'

//Type only import
import { HostClient } from './hostclient'

interface IDeployContent {
    script: string;
    content: { [key: string]: any };
    triggers: any[];
    deploymentOrder: number;
    typeName: string;
    object: number;
}

function never(n: never, message: string) { throw new Error(message); }

export class Deployment {
    status: DEPLOYMENT_STATUS = DEPLOYMENT_STATUS.Done;
    message: string;
    deploymentObjects: IDeploymentObject[] = [];
    log: string[];

    setStatus(s: DEPLOYMENT_STATUS) {
        this.status = s;
        let a: ISetDeploymentStatus = {
            type: ACTION.SetDeploymentStatus,
            status: s
        };
        webClients.broadcast(a);
    }

    setMessage(msg: string) {
        this.message = msg;
        let a: ISetDeploymentMessage = {
            type: ACTION.SetDeploymentMessage,
            message: msg
        };
        webClients.broadcast(a);
    }

    async setupDeploy(deployId: number, redeploy: boolean) {
        const objects: { [id: number]: IObject2<any> } = {};
        const hosts: number[] = [];
        const errors: string[] = [];
        this.deploymentObjects = [];

        const visitContent = (deploymentTitle: string, objContent: { [key: string]: any }, variables: { [key: string]: string }, type: IType, hasVars: boolean, content: { [key: string]: any }) => {
            for (let item of type.content || []) {
                switch (item.type) {
                    case TypePropType.bool:
                        {
                            let v = objContent[item.name] as boolean;
                            if (v === undefined || v === null) v = item.default;
                            if (item.variable) { hasVars = true; variables[item.variable] = v ? "true" : "false"; }
                            content[item.name] = v;
                            break;
                        }
                    case TypePropType.choice:
                        {
                            let v = objContent[item.name] as string;
                            if (v == undefined || v === null) v = item.default;
                            if (item.variable) { hasVars = true; variables[item.variable] = v; }
                            content[item.name] = v;
                            break;
                        }
                    case TypePropType.document:
                        {
                            let v = objContent[item.name] as string;
                            if (v == undefined || v === null) v = "";
                            if (item.template) v = Mustache.render(v, variables);
                            if (item.variable) { hasVars = true; variables[item.variable] = v; }
                            content[item.name] = v;
                            break;
                        }
                    case TypePropType.number:
                        {
                            let v = objContent[item.name] as number;
                            if (v == undefined || v === null) v = item.default;
                            content[item.name] = v;
                            break;
                        }
                    case TypePropType.password:
                        {
                            let v = objContent[item.name] as string;
                            if (v == undefined || v === null) v = "";
                            content[item.name] = v;
                            break;
                        }
                    case TypePropType.text:
                        {
                            let v = objContent[item.name] as string;
                            if (v == undefined || v === null) v = item.default;
                            if (item.template) v = Mustache.render(v, variables);
                            if (item.variable) { hasVars = true; variables[item.variable] = v; }
                            content[item.name] = v;
                            if (item.deployTitle) deploymentTitle = v;
                            break;
                        }
                    case TypePropType.none:
                    case TypePropType.typeContent:
                        break;
                    default:
                        never(item, "We should not get here");
                }
            }
            const script = type.script && Mustache.render(type.script, variables);
            return { deploymentTitle, variables, script, content, hasVars };
        };

        const visitObject = (id: number, variables: { [key: string]: string }) => {
            const obj = objects[id];
            if (!obj) return null;
            const type = objects[obj.type] as IObject2<IType>;

            let content: { [key: string]: any } = {};
            variables = Object.assign({}, variables);
            let hasVars = false;

            if (type.content.hasVariables && 'variables' in obj.content) {
                for (const v of (obj.content as IVariables).variables)
                    variables[v.key] = v.value;
                hasVars = true;
            }
            if (type.content.nameVariable)
                variables[type.content.nameVariable] = obj.name;

            let deploymentTitle = obj.name;

            return visitContent(obj.name, obj.content, variables, type.content, hasVars, content);
        };

        // Collect all objects
        for (const r of await db.getAllObjectsFull()) {
            objects[r.id] = { id: r.id, name: r.name, type: r.type, content: JSON.parse(r.content), catagory: r.catagory, version: r.version };
            if (r.type == hostId)
                hosts.push(r.id);
        }

        // Compute root variables
        let rootVariable: { [key: string]: string } = {};
        if (rootInstanceId in objects) {
            const v = visitObject(rootInstanceId, rootVariable);
            if (v) rootVariable = v.variables;
        }

        // Find deployment objects on a host by host basis
        for (const hostId of hosts) {

            interface DagNode {
                name: string | null;
                id: number;
                next: DagNode[];
                inCount: number;
                typeOrder: number;
                triggers: IDeploymentTrigger[];
                deploymentTitle: string;
                script: string;
                content: { [key: string]: any }
            }

            const hostObject = objects[hostId];
            const hostVariables = visitObject(hostId, rootVariable).variables;
            const nodes = new Map<string, DagNode>();
            const centinals = new Map<number, DagNode>();
            const topVisiting = new Set<number>();
            let hostDeploymentObjects: IDeploymentObject[] = [];

            // Visit an object contained directly in the host
            let visitTop = (id: number) => {
                if (centinals.has(id)) return centinals.get(id);
                if (topVisiting.has(id)) {
                    errors.push("Cyclip dependency");
                    return null;
                }
                topVisiting.add(id);
                let centinal: DagNode = { next: [], name: id + ".cent", id: null, inCount: 0, typeOrder: 0, triggers: [], deploymentTitle: "", script: "", content: null };
                nodes.set(centinal.name, centinal);
                visit(id, [], [], centinal, hostVariables);
                topVisiting.delete(id);
                return centinal;
            }

            // Visit any object
            let visit = (id: number, path: number[], prefix: number[], sentinal: DagNode, variables: { [key: string]: string }) => {
                if (id == null) return;
                const name = prefix.join(".") + "." + id;
                if (nodes.has(name)) return nodes.get(name);

                const parent = objects[path[path.length - 1]];
                if (!(id in objects) || objects[id] == undefined) {
                    errors.push("Missing object " + id + " for host " + hostObject.name + " in " + parent.name);
                    return null;
                }
                const obj = objects[id];
                const type = objects[obj.type] as IObject2<IType>;
                if (path.indexOf(id) !== -1) {
                    errors.push(parent.name + " contains " + obj.name + " of which it is it self a member");
                    return null;
                }

                const v = visitObject(id, variables);
                if (!v) {
                    errors.push("Error visiting " + name + " " + obj.name + " " + type + " " + id + " "+v);
                    return null;
                }
                //v.script = type.content.script && Mustache.render(type.content.script, v.variables);
                v.content['name'] = obj.name;

                let node: DagNode = {
                    next: [sentinal],
                    name: prefix.join(".") + "." + id,
                    id,
                    inCount: 0,
                    typeOrder: type.content.deployOrder,
                    triggers: [],
                    deploymentTitle: v.deploymentTitle,
                    script: v.script,
                    content: v.content
                };
                nodes.set(node.name, node);

                if (type.content.hasTriggers && 'triggers' in obj.content) {
                    for (const trigger of (obj.content as ITriggers).triggers) {
                        if (!objects[trigger.id]) continue;
                        let x = visitContent("trigger", trigger.values, Object.assign({}, v.variables), (objects[trigger.id] as IObject2<IType>).content, false, {})
                        if (!x) continue;
                        let t: IDeploymentTrigger = { typeId: trigger.id, script: x.script, content: x.content, title: x.deploymentTitle };
                        node.triggers.push(t);
                    }
                }

                if (type.content.hasContains && 'contains' in obj.content) {
                    const childPath = path.slice(0);
                    childPath.push(id);
                    let childPrefix = prefix;
                    if (v.hasVars) {
                        childPrefix = childPrefix.slice(0);
                        childPrefix.push(id);
                    }

                    for (const childId of (obj.content as IContains).contains) {
                        const next = visit(childId, childPath, childPrefix, sentinal, v.variables);
                        if (next)
                            node.next.push(next)
                    }
                }

                if (type.content.hasDepends && 'depends' in obj.content) {
                    for (const depId of (obj.content as IDepends).depends) {
                        const cent = visitTop(depId);
                        if (cent)
                            cent.next.push(node);
                    }
                }
                return node;
            }

            // Visit all the things
            if ('contains' in hostObject.content)
                for (const depId of (hostObject.content as IContains).contains)
                    visitTop(depId);

            if (errors.length != 0) continue;

            const hostFull = deployId == null || deployId == hostId;

            // Find all nodes reachable from deployId, and prep them for top sort
            const seen = new Set<DagNode>();
            const toVisit: DagNode[] = [];
            nodes.forEach((node, key) => {
                if (node && (node.id == deployId || hostFull)) {
                    toVisit.push(node);
                    seen.add(node);
                }
            });

            // There is nothing to deploy here
            if (toVisit.length == 0 && !hostFull) continue;

            // Perform topsort and construct deployment objects
            while (toVisit.length !== 0) {
                const node = toVisit.pop();
                for (const next of node.next) {
                    if (!next) continue;
                    next.inCount++;
                    if (seen.has(next)) continue;
                    toVisit.push(next);
                    seen.add(next);
                }
            }

            const pq = new PriorityQueue<DagNode>((lhs, rhs) => {
                if (rhs.typeOrder != lhs.typeOrder) return rhs.typeOrder - lhs.typeOrder;
                return rhs.id - lhs.id;
            });

            seen.forEach((node) => {
                const obj = objects[node.id];
                if (obj == undefined) return;
                const type = objects[obj.type] as IObject2<IType>;
                if (type == undefined) return;
                node.typeOrder = type.content.deployOrder;
                if (node.inCount == 0) pq.enq(node);
            });



            const oldContent: { [name: string]: { content: IDeployContent, type: number, title: string, name: string } } = {};
            for (const row of await db.getDeployments(hostId)) {
                let c = JSON.parse(row.content) as IDeployContent;
                if (!c.content) continue;
                oldContent[row.name] = { content: c, type: row.type, title: row.title, name: row.name };
            }

            while (!pq.isEmpty()) {
                const node = pq.deq();
                for (const next of node.next) {
                    if (!next) continue;
                    next.inCount--;
                    if (next.inCount == 0)
                        pq.enq(next);
                }
                if (node.id == null) continue;
                const obj = objects[node.id];
                if (!obj) continue;
                const type = objects[obj.type] as IObject2<IType>;
                if (type.content.kind == "collection" || type.content.kind == "root" || type.content.kind == "host") continue;

                const o: IDeploymentObject = {
                    index: 0,
                    enabled: true,
                    status: DEPLOYMENT_OBJECT_STATUS.Normal,
                    action: DEPLOYMENT_OBJECT_ACTION.Add,
                    hostName: hostObject.name,
                    title: node.deploymentTitle,
                    name: node.name,
                    script: node.script,
                    nextContent: node.content,
                    prevContent: null,
                    host: hostId,
                    triggers: node.triggers,
                    typeName: type.name,
                    id: node.id,
                    typeId: obj.type,
                    deploymentOrder: node.typeOrder,
                };

                if (node.name in oldContent) {
                    if (!redeploy) {
                        o.prevContent = oldContent[node.name].content.content;
                        o.action = DEPLOYMENT_OBJECT_ACTION.Modify;
                    }
                    delete oldContent[node.name];
                }
                hostDeploymentObjects.push(o);
            }

            // Filter away stuff that has not changed
            hostDeploymentObjects = hostDeploymentObjects.filter(o => {
                let a = JSON.stringify(o.nextContent);
                let b = JSON.stringify(o.prevContent);
                return a !== b;
            });

            // Find stuff to remove
            if (hostFull) {
                const values: { content: IDeployContent, type: number, title: string, name: string }[] = [];
                for (const name in oldContent)
                    values.push(oldContent[name]);

                values.sort((l, r) => {
                    const lo = l.content.deploymentOrder;
                    const ro = r.content.deploymentOrder;
                    if (lo != ro) return ro - lo;
                    return l.name < r.name ? -1 : 1;
                })

                for (const v of values) {
                    const o: IDeploymentObject = {
                        index: 0,
                        enabled: true,
                        status: DEPLOYMENT_OBJECT_STATUS.Normal,
                        action: DEPLOYMENT_OBJECT_ACTION.Remove,
                        hostName: hostObject.name,
                        title: v.title,
                        name: v.name,
                        script: v.content.script,
                        nextContent: null,
                        prevContent: v.content.content,
                        host: hostId,
                        triggers: v.content.triggers,
                        typeName: v.content.typeName,
                        id: v.content.object,
                        typeId: v.type,
                        deploymentOrder: v.content.deploymentOrder
                    };
                    hostDeploymentObjects.push(o);
                }
            }
            let triggers: IDeploymentTrigger[] = [];
            for (let o of hostDeploymentObjects) {
                this.deploymentObjects.push(o);
                for (let trigger of o.triggers)
                    triggers.push(trigger);
            }

            triggers.sort((l, r) => {
                if (l.typeId != r.typeId) return l.typeId - r.typeId;
                if (l.script != r.script) return l.script < r.script ? -1 : 1;
                return JSON.stringify(l.content) < JSON.stringify(r.content) ? -1 : 1;
            });

            for (let i = 0; i < triggers.length; ++i) {
                let t = triggers[i];
                if (i != 0 && t.typeId == triggers[i - 1].typeId && t.script == triggers[i - 1].script && JSON.stringify(t.content) == JSON.stringify(triggers[i - 1].content)) continue;

                let o: IDeploymentObject = {
                    index: 0,
                    enabled: true,
                    status: DEPLOYMENT_OBJECT_STATUS.Normal,
                    action: DEPLOYMENT_OBJECT_ACTION.Trigger,
                    hostName: hostObject.name,
                    title: t.title,
                    name: "",
                    script: t.script,
                    nextContent: t.content,
                    prevContent: null,
                    host: hostId,
                    triggers: [],
                    typeName: objects[t.typeId].name,
                    id: null,
                    typeId: t.typeId,
                    deploymentOrder: 0
                };
                this.deploymentObjects.push(o);
            }
        }

        if (errors.length != 0) {
            this.deploymentObjects = [];
            this.setStatus(DEPLOYMENT_STATUS.InvilidTree);
            this.setMessage(errors.join("\n"));
            return;
        }

        for (let i = 0; i < this.deploymentObjects.length; ++i)
            this.deploymentObjects[i].index = i;

        let a: ISetDeploymentObjects = {
            type: ACTION.SetDeploymentObjects,
            objects: this.getView()
        };
        webClients.broadcast(a);
        if (this.deploymentObjects.length == 0) {
            this.setStatus(DEPLOYMENT_STATUS.Done);
            this.setMessage("Everything up to date, nothing to deploy!");
        } else {
            this.setStatus(DEPLOYMENT_STATUS.ReviewChanges);
        }
    }

    wait(time: number) {
        return new Promise<{}>(cb => {
            setTimeout(cb, time);
        })
    }

    setObjectStatus(index: number, status: DEPLOYMENT_OBJECT_STATUS) {
        this.deploymentObjects[index].status = status;
        let a: ISetDeploymentObjectStatus = {
            type: ACTION.SetDeploymentObjectStatus,
            index: index,
            status: status
        }
        webClients.broadcast(a);
    }

    deploySingle(hostClient: HostClient, script: string, content: any) {
        return new Promise<{ success: boolean, code: number }>(cb => {
            new DeployJob(hostClient, script, content, (success, code) => cb({ success, code }));
        });
    }

    async performDeploy() {
        const types: { [id: number]: IObject2<IType> } = {};

        for (const r of await db.getAllObjectsFull())
            if (r.type == typeId)
                types[r.id] = { id: r.id, name: r.name, type: r.type, content: JSON.parse(r.content) as IType, catagory: r.catagory, version: r.version };


        this.addLog("Deployment started\r\n")

        this.setStatus(DEPLOYMENT_STATUS.Deploying);
        let badHosts = new Set<number>();
        let curHost = -1;

        let hostObjects: { [type: number]: { [name: string]: { [key: string]: any } } } = {};

        for (let i = 0; i < this.deploymentObjects.length; ++i) {
            let o = this.deploymentObjects[i];
            if (!o.enabled) continue;
            let type = types[o.typeId];

            if (badHosts.has(o.host)) {
                this.setObjectStatus(o.index, DEPLOYMENT_OBJECT_STATUS.Failure);
                continue
            }

            if (o.host != curHost) {
                curHost = o.host;
                this.addHeader(o.hostName, "=");
                hostObjects = {};
                for (const row of await db.getDeployments(curHost)) {
                    let c = JSON.parse(row.content) as IDeployContent;
                    if (!c.content) continue;
                    if (!(row.type in hostObjects)) hostObjects[row.type] = {};
                    hostObjects[row.type][row.name] = c.content;
                }
            }

            let hostClient = hostClients.hostClients[o.host];
            if (!hostClient || hostClient.closeHandled) {
                this.addLog("Host " + o.hostName + " is down\r\n");
                badHosts.add(o.host);
                this.setObjectStatus(o.index, DEPLOYMENT_OBJECT_STATUS.Failure);
                continue;
            }

            if (type.content.kind == "sum") {
                let j = i;

                let curObjects = hostObjects[o.typeId] || {};
                let nextObjects = Object.assign({}, curObjects);

                for (; j < this.deploymentObjects.length; ++j) {
                    let o2 = this.deploymentObjects[j];
                    if (!o2.enabled) continue;
                    if (o2.typeId !== o.typeId) break;
                    if (o2.host != o.host) break;
                    this.setObjectStatus(j, DEPLOYMENT_OBJECT_STATUS.Deplying);

                    if (o2.prevContent)
                        delete nextObjects[o2.name];
                    if (o2.nextContent)
                        nextObjects[o2.name] = o2.nextContent;
                }

                let ans = await this.deploySingle(hostClient, o.script, { objects: nextObjects });

                let ok = ans.success && ans.code == 0;
                if (!ok) {
                    for (let k = i; k < j; ++k) {
                        let o2 = this.deploymentObjects[k];
                        if (!o2.enabled) continue;
                        this.setObjectStatus(k, DEPLOYMENT_OBJECT_STATUS.Failure);
                    }
                    if (ans.success)
                        this.addLog("\r\nFailed with exit code " + ans.code + "\r\n");
                    else
                        this.addLog("\r\nFailed\r\n");
                    badHosts.add(o.host);
                } else {
                    hostObjects[o.typeId] = nextObjects;

                    for (let k = i; k < j; ++k) {
                        let o2 = this.deploymentObjects[k];
                        if (!o2.enabled) continue;

                        let c: IDeployContent = {
                            content: o2.nextContent,
                            script: o2.script,
                            triggers: o2.triggers,
                            deploymentOrder: o2.deploymentOrder,
                            typeName: o2.typeName,
                            object: o2.id,
                        };
                        await db.setDeployment(o2.host, o2.name, JSON.stringify(c), o2.typeId, o2.title);
                        this.setObjectStatus(k, DEPLOYMENT_OBJECT_STATUS.Success);
                    }
                }
                i = j - 1;
                continue;

            }


            this.addHeader(o.title + " (" + o.typeName + ")", "-");

            this.setObjectStatus(o.index, DEPLOYMENT_OBJECT_STATUS.Deplying);

            let ans = { success: false, code: 0 };

            if (type.content.kind == "trigger") {
                ans = await this.deploySingle(hostClient, o.script, o.nextContent)
            } else if (type.content.kind == "delta") {
                ans = await this.deploySingle(hostClient, o.script, { old: o.prevContent, new: o.nextContent });
            }

            let ok = ans.success && ans.code == 0;
            if (!ok) {
                if (ans.success)
                    this.addLog("\r\nFailed with exit code " + ans.code + "\r\n");
                else
                    this.addLog("\r\nFailed\r\n");
                if (type.content.kind != "trigger")
                    badHosts.add(o.host);
            } else if (type.content.kind != "trigger") {
                let c: IDeployContent = {
                    content: o.nextContent,
                    script: o.script,
                    triggers: o.triggers,
                    deploymentOrder: o.deploymentOrder,
                    typeName: o.typeName,
                    object: o.id,
                };
                await db.setDeployment(o.host, o.name, JSON.stringify(c), o.typeId, o.title);
            }
            this.setObjectStatus(o.index, ok ? DEPLOYMENT_OBJECT_STATUS.Success : DEPLOYMENT_OBJECT_STATUS.Failure);
        }
        this.setStatus(DEPLOYMENT_STATUS.Done);
    }

    getView() {
        return this.deploymentObjects;
    }

    async deployObject(id: number, redeploy: boolean) {
        this.setStatus(DEPLOYMENT_STATUS.BuildingTree);
        this.clearLog();
        this.setMessage("");
        await this.setupDeploy(id, redeploy);
    }

    async start() {
        if (this.status != DEPLOYMENT_STATUS.ReviewChanges) return;
        await this.performDeploy();
    }

    stop() {
        if (this.status != DEPLOYMENT_STATUS.Deploying) return;
        //TODO we should wait for the current action to finish
        this.setStatus(DEPLOYMENT_STATUS.Done);
    }

    cancel() {
        if (this.status != DEPLOYMENT_STATUS.ReviewChanges) return;
        this.setStatus(DEPLOYMENT_STATUS.Done);
        this.deploymentObjects = [];
        let a: ISetDeploymentObjects = {
            type: ACTION.SetDeploymentObjects,
            objects: this.getView()
        };
        webClients.broadcast(a);
        this.setMessage("");
    }

    toggleObject(index: number, enabled: boolean) {
        if (this.status != DEPLOYMENT_STATUS.ReviewChanges) return;

        this.deploymentObjects[index].enabled = enabled;

        let a: IToggleDeploymentObject = {
            type: ACTION.ToggleDeploymentObject,
            index,
            enabled,
            source: "server"
        }
        webClients.broadcast(a);
    }

    clearLog() {
        this.log = [];
        let a: IClearDeploymentLog = {
            type: ACTION.ClearDeploymentLog,
        }
        webClients.broadcast(a);
    }

    addHeader(name: string, sep: string = "-") {
        let t = 100 - 4 - name.length;
        let l = t / 2;
        let r = t - l;
        this.addLog("\r\n\x1b[91m" + sep.repeat(l) + "> " + name + " <" + sep.repeat(r) + "\x1b[0m\r\n");
    }

    addLog(bytes: string) {
        this.log.push(bytes);

        let a: IAddDeploymentLog = {
            type: ACTION.AddDeploymentLog,
            bytes: bytes
        }
        webClients.broadcast(a);
    }
};
