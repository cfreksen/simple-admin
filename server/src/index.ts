import {WebClients} from './webclient';
import {HostClients} from './hostclient';
import {DB} from './db'
import {Msg} from './msg'
import {Deployment} from './deployment'
import * as instances from './instances';
import {errorHandler} from './error'
import {log} from 'winston';
import { ModifiedFiles } from './modifiedfiles';
import winston = require('winston');

const exitHook = require('async-exit-hook');

winston.add(new winston.transports.Console());
log("info", "STARTING SERVER");

async function setup() {
    instances.setMsg(new Msg());
    instances.setDeployment(new Deployment());
    instances.setDb(new DB());
    instances.setModifiedFiles(new ModifiedFiles());

    try {
        await instances.db.init()
    } catch (err) {
        errorHandler("db")(err);
    }
    instances.setWebClients(new WebClients());
    instances.webClients.startServer();
    instances.setHostClients(new HostClients());
    instances.hostClients.start();
};

setup();
