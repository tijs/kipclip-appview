/* esm.sh - @jsr/tijs__actor-typeahead@0.2.2 */
var d=document.createElement("template");d.innerHTML=`
  <slot></slot>

  <ul class="menu" part="menu"></ul>

  <style>
    :host {
      --color-background-inherited: var(--color-background, #ffffff);
      --color-border-inherited: var(--color-border, #e5e7eb);
      --color-shadow-inherited: var(--color-shadow, #000000);
      --color-hover-inherited: var(--color-hover, #fff1f1);
      --color-avatar-fallback-inherited: var(--color-avatar-fallback, #fecaca);
      --radius-inherited: var(--radius, 8px);
      --padding-menu-inherited: var(--padding-menu, 4px);
      display: block;
      position: relative;
      font-family: system-ui;
    }

    *, *::before, *::after {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    .menu {
      display: flex;
      flex-direction: column;
      position: absolute;
      left: 0;
      margin-top: 4px;
      width: 100%;
      list-style: none;
      overflow: hidden;
      background-color: var(--color-background-inherited);
      background-clip: padding-box;
      border: 1px solid var(--color-border-inherited);
      border-radius: var(--radius-inherited);
      box-shadow: 0 6px 6px -4px rgb(from var(--color-shadow-inherited) r g b / 20%);
      padding: var(--padding-menu-inherited);
      z-index: 50;
    }

    .menu:empty {
      display: none;
    }

    .user {
      all: unset;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      width: 100%;
      height: calc(1.5rem + 6px * 2);
      border-radius: calc(var(--radius-inherited) - var(--padding-menu-inherited));
      cursor: default;
    }

    .user:hover,
    .user[data-active="true"] {
      background-color: var(--color-hover-inherited);
    }

    .avatar {
      width: 1.5rem;
      height: 1.5rem;
      border-radius: 50%;
      background-color: var(--color-avatar-fallback-inherited);
      overflow: hidden;
      flex-shrink: 0;
    }

    .img {
      display: block;
      width: 100%;
      height: 100%;
    }

    .handle {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  </style>
`;var l=document.createElement("template");l.innerHTML=`
  <li>
    <button class="user" part="user">
      <div class="avatar" part="avatar">
        <img class="img" part="img">
      </div>
      <span class="handle" part="handle"></span>
    </button>
  </li>
`;function h(o){return o.cloneNode(!0)}var n=class extends HTMLElement{static tag="actor-typeahead";static define(e=this.tag){this.tag=e;let t=customElements.getName(this);if(t&&t!==e)return console.warn(`${this.name} already defined as <${t}>!`);let r=customElements.get(e);if(r&&r!==this)return console.warn(`<${e}> already defined as ${r.name}!`);customElements.define(e,this)}static{let e=new URL(import.meta.url).searchParams.get("tag")||this.tag;e!=="none"&&this.define(e)}#a=this.attachShadow({mode:"closed"});#r=[];#e=-1;#s=!1;#i=!1;constructor(){super(),this.#a.append(h(d).content),this.#t(),this.addEventListener("input",this),this.addEventListener("focusout",this),this.addEventListener("keydown",this),this.#a.addEventListener("pointerdown",this),this.#a.addEventListener("pointerup",this),this.#a.addEventListener("click",this)}get#n(){let e=Number.parseInt(this.getAttribute("rows")??"");return Number.isNaN(e)?5:e}handleEvent(e){switch(e.type){case"input":this.#h(e);break;case"keydown":this.#c(e);break;case"focusout":this.#d();break;case"pointerdown":this.#l();break;case"pointerup":this.#u(e);break;case"click":this.#p(e);break}}#c(e){switch(e.key){case"ArrowDown":e.preventDefault(),this.#e=Math.min(this.#e+1,this.#n-1),this.#t();break;case"PageDown":e.preventDefault(),this.#e=this.#n-1,this.#t();break;case"ArrowUp":e.preventDefault(),this.#e=Math.max(this.#e-1,0),this.#t();break;case"PageUp":e.preventDefault(),this.#e=0,this.#t();break;case"Escape":e.preventDefault(),this.#r=[],this.#e=-1,this.#t();break;case"Enter":this.#r.length>0&&this.#e>=0&&(e.preventDefault(),this.#a.querySelectorAll("button")[this.#e]?.click());break}}async#h(e){if(this.#i)return;let t=e.target?.value;if(!t){this.#r=[],this.#t();return}let r=this.getAttribute("host")??"https://public.api.bsky.app",a=new URL("xrpc/app.bsky.actor.searchActorsTypeahead",r);a.searchParams.set("q",t),a.searchParams.set("limit",`${this.#n}`);let i=await(await fetch(a)).json();this.#r=i.actors,this.#e=-1,this.#t()}#d(){setTimeout(()=>{!this.#s&&document.activeElement!==this.querySelector("input")&&(this.#r=[],this.#e=-1,this.#t())},150)}#t(){let e=document.createDocumentFragment(),t=-1;for(let r of this.#r){let a=h(l).content,s=a.querySelector("button");s&&(s.dataset.handle=r.handle,++t===this.#e&&(s.dataset.active="true"));let i=a.querySelector("img");i&&r.avatar&&(i.src=r.avatar);let c=a.querySelector(".handle");c&&(c.textContent=r.handle),e.append(a)}this.#a.querySelector(".menu")?.replaceChildren(...e.children)}#l(){this.#s=!0}#u(e){this.#s=!1;let t=e.target?.closest("button"),r=this.querySelector("input");!r||!t||this.#o(r,t.dataset.handle||"")}#p(e){let t=e.target?.closest("button"),r=this.querySelector("input");!r||!t||(e.preventDefault(),e.stopPropagation(),this.#o(r,t.dataset.handle||""))}#o(e,t){this.#r=[],this.#e=-1,this.#t(),e.value=t,this.#i=!0,e.dispatchEvent(new Event("input",{bubbles:!0})),this.#i=!1,e.focus()}};export{n as ActorTypeahead};
//# sourceMappingURL=tijs__actor-typeahead.bundle.mjs.map