import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function setup(search = '', autoReady = true) {
  const html = readFileSync(new URL('../public/sketchfab/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, { value: id === '#step' ? '5' : '', hidden: false, textContent:'', listeners:{}, addEventListener(type, fn) { this.listeners[type]=fn }, setAttribute(){}, append(){}, replaceChildren(){}, reset(){} });
    return elements.get(id);
  }
  const orbits = ['left','right','up','down'].map(orbit => ({ dataset:{orbit}, addEventListener(type,fn){this.click=fn} }));
  const views = [];
  const camera = {position:[10,-10,10], target:[0,0,0]};
  let fov=45, ready; const readyCallbacks=[], requests=[]; const viewers=[]; let copied; const fovRequests=[];
  const api = {start(){},addEventListener(_event,fn){ready=fn;readyCallbacks.push(fn)},setBackground(){},getCameraLookAt(cb){cb(null,{position:[...camera.position],target:[...camera.target]})},getFov(cb){cb(null,fov)},setFov(value,cb){fovRequests.push(value); fov=value;cb?.(null,value)},setCameraLookAt(pos,target,_duration,cb){camera.position=[...pos];camera.target=[...target];cb?.(null)},getScreenShot(){}};
  const document={querySelector:element,querySelectorAll(selector){return selector==='[data-orbit]'?orbits:views},createElement(){return element('temporary')},body:{appendChild(){}}};
  class Sketchfab {init(id,opts){viewers.push({id,opts}); opts.success(api)}}
  const context={document,Sketchfab,URL,URLSearchParams,location:{search,pathname:'/sketchfab/',origin:'https://example.test'},localStorage:{getItem(){return null},setItem(){}},fetch:async(url,options)=>{requests.push({url,...options});return {ok:false,text:async()=>''}},navigator:{clipboard:{writeText:async value=>{copied=value}}},console};
  vm.createContext(context);vm.runInContext(script,context);if(autoReady)ready();
  return {context,element,orbits,camera,getFov:()=>fov, viewers, fovRequests, ready:()=>ready(), getCopied:()=>copied, api, readyCallbacks, requests};
}
describe('Sketchfab camera controls',()=>{
  it('switches between flat, original and wider FOV while preserving the target and framing',()=>{
    const s=setup(), distance=()=>Math.hypot(...s.camera.position);
    const initial=distance(), flat=s.getFov();
    s.element('#projection').listeners.change({target:{value:'original'}});
    expect(s.getFov()).toBe(45);
    expect(distance()*Math.tan(45*Math.PI/360)).toBeCloseTo(initial*Math.tan(flat*Math.PI/360),5);
    s.element('#projection').listeners.change({target:{value:'wide'}});
    expect(s.getFov()).toBeGreaterThan(45);
    s.element('#projection').listeners.change({target:{value:'flat'}});
    expect(s.getFov()).toBeCloseTo(1);
    expect(distance()).toBeCloseTo(initial,4);
  });
  it('restores a shared model and camera without using account data',()=>{
    const s=setup('?model=Abc123&projection=wide&position=12%2C-24%2C18&target=1%2C2%2C3');
    expect(s.element('#model').value).toBe('Abc123');
    expect(s.element('#projection').value).toBe('wide');
    expect(s.camera.position).toEqual([12,-24,18]);
    expect(s.camera.target).toEqual([1,2,3]);
    expect(s.getFov()).toBeGreaterThan(45);
  });
  it('uses the supported minimum FOV and preserves the initial framing',()=>{
    const s=setup();
    expect(s.fovRequests.every(fov=>fov>=1 && fov<179)).toBe(true);
    expect(Math.hypot(...s.camera.position)*Math.tan(s.getFov()*Math.PI/360)).toBeCloseTo(Math.sqrt(300)*Math.tan(45*Math.PI/360),6);
  });
  it('shares the loaded model even when the input has been edited',async()=>{
    const s=setup(); s.element('#model').value='DifferentModel';
    s.element('#share').listeners.click();
    const url=new URL(s.getCopied());
    expect(url.searchParams.get('model')).toBe('e7d6ce6350fc4039a58cafe6d05d1c09');
    expect(url.searchParams.get('fov')).toBe('1');
    const restored=setup(url.search);
    expect(restored.camera.position).toEqual(s.camera.position.map(n=>Number(n.toPrecision(9))));
  });
  it('does not apply an initial shared camera to a later model',()=>{
    const s=setup('?model=Abc123&projection=wide&position=12,-24,18&target=1,2,3');
    s.element('#model').value='NewModel';
    s.element('#form').listeners.submit({preventDefault(){}}); s.ready();
    expect(s.getFov()).toBe(1);
    expect(s.element('#projection').value).toBe('flat');
  });
  it('rejects malformed shared vectors and FOV values',()=>{
    for(const query of ['position=,,&target=0,0,0', 'position=1,2,3&target=0,0,0&fov=0.01', 'position=1,2,3&target=1,2,3']) {
      const s=setup('?model=Abc123&projection=wide&'+query);
      expect(s.getFov()).toBe(1);
    }
  });
  it('ignores delayed camera callbacks after another model is requested',()=>{
    const s=setup(); let callback;
    s.api.getCameraLookAt=cb=>{callback=cb};
    s.element('#share').listeners.click();
    s.element('#model').value='AnotherModel';
    s.element('#form').listeners.submit({preventDefault(){}});
    callback(null,{position:[1,2,3],target:[0,0,0]});
    expect(s.getCopied()).toBeUndefined();
  });
  it('saves the loaded model rather than unsent input text',async()=>{
    const s=setup(); s.element('#model').value='DifferentModel';
    s.context.FormData=class {get(){return 'Study'}};
    await s.element('#save-model').listeners.submit({preventDefault(){},target:{reset(){}}});
    const saved=s.requests.find(r=>r.url==='/api/models' && r.method==='POST');
    expect(JSON.parse(saved.body)).toEqual({uid:'e7d6ce6350fc4039a58cafe6d05d1c09',title:'Study'});
  });
  it('ignores viewerready from an initialization replaced by another model',()=>{
    const s=setup('?model=Abc123&projection=wide&position=12,-24,18&target=1,2,3',false);
    s.element('#model').value='AnotherModel';
    s.element('#form').listeners.submit({preventDefault(){}});
    s.readyCallbacks[0]();
    expect(s.fovRequests).toEqual([]);
    s.readyCallbacks[1]();
    expect(s.getFov()).toBe(1);
    s.element('#share').listeners.click();
    expect(new URL(s.getCopied()).searchParams.get('model')).toBe('AnotherModel');
  });
  it('does not combine an old camera response with a new projection',()=>{
    const s=setup(); let callback;
    const getCamera=s.api.getCameraLookAt;
    s.api.getCameraLookAt=cb=>{callback=cb};
    s.element('#share').listeners.click();
    s.api.getCameraLookAt=getCamera;
    s.element('#projection').listeners.change({target:{value:'wide'}});
    callback(null,{position:[1,2,3],target:[0,0,0]});
    expect(s.getCopied()).toBeUndefined();
  });
  it('rotates horizontally without changing elevation or camera distance, and vertically without changing azimuth',()=>{
    const s=setup(); const before=[...s.camera.position];
    s.orbits[0].click(); const horizontal=[...s.camera.position];
    expect(horizontal[2]).toBeCloseTo(before[2],4);
    expect(Math.hypot(...horizontal)).toBeCloseTo(Math.hypot(...before),4);
    expect(horizontal[0]).not.toBeCloseTo(before[0],3);
    const azimuth=Math.atan2(horizontal[1],horizontal[0]);
    s.orbits[2].click(); expect(Math.atan2(s.camera.position[1],s.camera.position[0])).toBeCloseTo(azimuth,6);
    expect(s.camera.position[2]).not.toBeCloseTo(horizontal[2],3);
  });
});
