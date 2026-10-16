(function (root) {
  'use strict';
  const fields = ['brand','creativeType','date','version','creator','concept1','concept2','concept3','subconcept','theme'];
  function defaults(now = new Date()) {
    const date = [now.getFullYear(), String(now.getMonth()+1).padStart(2,'0'), String(now.getDate()).padStart(2,'0')].join('-');
    return {brand:'',creativeType:'',date,version:'01',creator:'',customCreator:'',concept1:'',concept2:'',concept3:'',subconcept:'none',theme:'none'};
  }
  function choices(key, values, data) {
    if (key === 'creativeType') return {mip:'',sip:''};
    if (key === 'creator') return {emily:'',haley:'',lingyun:'',charlotte:'',ecomm:'',custom:''};
    if (key === 'concept1') return Object.fromEntries(Object.entries(data.concepts).map(([k,v]) => [k,v.description]));
    if (key === 'concept2') return data.concepts[values.concept1]?.children || {};
    return data[key];
  }
  function change(values, key, value, data) {
    values[key] = value;
    if (key === 'concept1' && !Object.hasOwn(choices('concept2', values, data), values.concept2)) values.concept2 = '';
  }
  function versionAt(start, offset = 0) {
    const value = String(start).trim();
    if (!/^[0-9]+$/.test(value) || !/[1-9]/.test(value)) return start;
    return (BigInt(value) + BigInt(offset)).toString().padStart(2,'0');
  }
  function nextVersion(start, versions) {
    let next = versionAt(start);
    if (!/^[0-9]+$/.test(next) || !/[1-9]/.test(next)) return start;
    for (const version of versions) {
      const value = String(version).trim();
      if (/^[0-9]+$/.test(value) && BigInt(value) >= BigInt(next)) next = versionAt(value,1);
    }
    return next;
  }
  function filename(values, extension, data) {
    const v = Object.fromEntries(Object.entries(values).map(([k,x]) => [k,String(x).trim().toLowerCase()]));
    for (const key of fields) {
      const options = choices(key,v,data);
      if (options && !Object.hasOwn(options,v[key])) throw Error('Choose ' + key);
    }
    const creator = v.creator === 'custom' ? v.customCreator : v.creator;
    for (const [label,value] of [['Brand',v.brand],['Creator',creator]]) if (!/^[a-z0-9-]+$/.test(value || '')) throw Error(label + ': use letters, digits, or hyphens');
    if (!/^[0-9]+$/.test(v.version) || !/[1-9]/.test(v.version)) throw Error('Version must be a positive integer');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date) || v.date.startsWith('0000') || !Number.isFinite(Date.parse(v.date)) || new Date(v.date).toISOString().slice(0,10) !== v.date) throw Error('Choose a valid date');
    const name = [v.brand,'acslanot',v.creativeType,v.date.replaceAll('-',''),v.version.replace(/^0+/,'').padStart(2,'0'),creator,v.concept1,v.concept2,v.concept3,v.subconcept,v.theme].join('_') + extension;
    if (name.length > 255) throw Error('Filename exceeds 255 characters');
    return name;
  }
  const api = {fields,defaults,choices,change,filename,versionAt,nextVersion};
  if (typeof module === 'object') module.exports = api; else root.FileRenamerModel = api;
})(globalThis);
