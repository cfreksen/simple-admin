import * as React from "react";
import * as State from './shared/state';
import Button from "@material-ui/core/Button";
import state from "./state";
import { observer } from "mobx-react";
import { rootInstanceId, rootId } from './shared/type';
import MenuDropdown, { DropDownItem } from "./MenuDropdown";

export const ObjectMenuList = observer(function ObjectMenuList({type}:{type:number}) {
    const page = state.page;
    if (!page) return <span>Missing state.page</span>;
    let lst = [];
    const digests = state.objectDigests.get(type);
    if (digests !== undefined) {
        for (let [i, v] of digests) {
            lst.push(v);
        }
        lst.sort((l,r)=>{return l.name < r.name ? -1 : 1;});
    }
    return (
        <>
            <DropDownItem
                key="new"
                onClick={(e)=>page.onClick(e, {type:State.PAGE_TYPE.Object, objectType: type})}
                href={page.link({type:State.PAGE_TYPE.Object, objectType: type})}>
                new
            </DropDownItem>
            <DropDownItem
                key="list"
                onClick={(e)=>page.onClick(e, {type:State.PAGE_TYPE.ObjectList, objectType: type})}
                href={page.link({type:State.PAGE_TYPE.ObjectList, objectType: type})}>
                list
            </DropDownItem>
            <DropDownItem/>
            {lst.map(v=>
             <DropDownItem
                key={v.id}
                onClick={(e)=>page.onClick(e, {type:State.PAGE_TYPE.Object, objectType: type, id: v.id})}
                href={page.link({type:State.PAGE_TYPE.Object, objectType: type, id: v.id})}>
                {v.name}
            </DropDownItem>
            )}
        </>
        );
});


const TypeMenuItem = observer(function TypeMenuItem({id}:{id:number}) {
    const page = state.page;
    if (!page) return <span>Missing state.page</span>;
    const type = state.types.get(id);
    if (!type) return <span>Missing type</span>;
    const name = type.name;
    if (id == rootId) {
        return <Button 
           key={rootInstanceId}
           onClick={(e)=>page.onClick(e, {type:State.PAGE_TYPE.Object, objectType: rootId, id: rootInstanceId})}
           href={page.link({type:State.PAGE_TYPE.Object, objectType: rootId, id: rootInstanceId})}>{name}</Button>;
   }
   return <MenuDropdown title={name}>
        <ObjectMenuList type={id} />
   </MenuDropdown>;
});

export default TypeMenuItem;

