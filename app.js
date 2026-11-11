/* RE Hub · app instalable (PWA) para el iPhone.
 * Datos: Libro maestro RE a través de «RE Hub API» (Apps Script). Nada de datos ni claves en este código.
 * Bloqueo: PIN local + Face ID (WebAuthn). Sin conexión: último Libro leído + cola de incidencias.
 */
'use strict';
var RAW = null, M = null, VISTA = {t:'hoy'}, COLA = [], ONLINE = navigator.onLine, CARGANDO = false, ULT_ERR = '';
var K = {cfg:'rehub_cfg', pin:'rehub_pin', fid:'rehub_fid', datos:'rehub_datos', intentos:'rehub_intentos'};
var BLOQUEO_MIN = 5; // minutos en segundo plano antes de volver a pedir PIN / Face ID

function lsGet(k){try{var v=localStorage.getItem(k);return v?JSON.parse(v):null;}catch(_){return null;}}
function lsSet(k,v){try{localStorage.setItem(k,JSON.stringify(v));return true;}catch(_){return false;}}
function lsDel(k){try{localStorage.removeItem(k);}catch(_){}}
function hoyISO(){var d=new Date();return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2);}
function uid(){var a=new Uint8Array(12);crypto.getRandomValues(a);return Array.prototype.map.call(a,function(x){return ('0'+x.toString(16)).slice(-2);}).join('');}
function b64u(buf){var s='',b=new Uint8Array(buf);for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function b64uDec(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var b=atob(s),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u;}
function rnd(n){var a=new Uint8Array(n);crypto.getRandomValues(a);return a;}

/* ---------- API ---------- */
function api(accion,datos){
  var cfg=lsGet(K.cfg); if(!cfg) return Promise.reject(new Error('sin-vincular'));
  return fetch(cfg.api,{method:'POST',redirect:'follow',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({clave:cfg.clave,accion:accion,datos:datos})})
    .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
    .then(function(j){
      if(!j.ok){ if(j.error==='no-autorizado'){lsDel(K.cfg);mostrarLock('vincular','El Libro ha rechazado la clave (¿se ha revocado?). Vincula de nuevo.');} throw new Error(j.error||'Error'); }
      return j;
    });
}

/* ---------- cola de incidencias sin conexión (IndexedDB) ---------- */
function db(){return new Promise(function(ok,ko){var r=indexedDB.open('rehub',1);r.onupgradeneeded=function(){r.result.createObjectStore('cola',{keyPath:'uid'});};r.onsuccess=function(){ok(r.result);};r.onerror=function(){ko(r.error);};});}
function colaTx(modo,fn){return db().then(function(d){return new Promise(function(ok,ko){var tx=d.transaction('cola',modo),st=tx.objectStore('cola'),res=fn(st);tx.oncomplete=function(){ok(res&&res.result!==undefined?res.result:res);};tx.onerror=function(){ko(tx.error);};});});}
function colaLeer(){return colaTx('readonly',function(st){return st.getAll();}).then(function(x){COLA=x||[];return COLA;}).catch(function(){return COLA;});}
function colaPoner(item){return colaTx('readwrite',function(st){st.put(item);}).then(colaLeer);}
function colaQuitar(u){return colaTx('readwrite',function(st){st.delete(u);}).then(colaLeer);}
var ENVIANDO=false;
function colaEnviar(){
  if(ENVIANDO||!navigator.onLine) return Promise.resolve();
  ENVIANDO=true;
  return colaLeer().then(function(items){
    if(!items.length){ENVIANDO=false;return;}
    var hechas=[];
    return items.reduce(function(p,it){return p.then(function(){
      return api('incidencia',it).then(function(j){hechas.push(j.res.id);return colaQuitar(it.uid);}).catch(function(e){ULT_ERR='No se ha podido enviar una incidencia guardada: '+e.message;});
    });},Promise.resolve()).then(function(){
      ENVIANDO=false;
      if(hechas.length){ULT_ERR='';avisar('Enviadas al Libro: '+hechas.join(', '));cargar(false);}
      else pintar();
    });
  });
}
var AVISO='';
function avisar(t){AVISO=t;pintar();setTimeout(function(){if(AVISO===t){AVISO='';pintar();}},5000);}

/* ---------- bloqueo: vinculación, PIN y Face ID ---------- */
var PIN_TMP='', PIN_1='', LOCK_MODO='', LOCK_MSG='';
function sha(t){return crypto.subtle.digest('SHA-256',new TextEncoder().encode(t)).then(b64u);}
function hayFaceID(){return window.PublicKeyCredential&&PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(function(){return false;}):Promise.resolve(false);}

function mostrarLock(modo,msg){
  LOCK_MODO=modo; LOCK_MSG=msg||''; PIN_TMP='';
  document.getElementById('lock').style.display='flex';
  document.getElementById('nav').style.display='none';
  pintarLock();
}
function quitarLock(){
  LOCK_MODO=''; document.getElementById('lock').style.display='none'; document.getElementById('lock').innerHTML='';
  arrancar();
}
function pintarLock(){
  var el=document.getElementById('lock'), h='<img class="logo" src="icon-180.png" alt="">';
  if(LOCK_MODO==='vincular'){
    h+='<h1>Vincular con el Libro</h1><p>Pega el código de vinculación que te da <b>configurarApp()</b> en «RE Hub API». Empieza por <code>rehub1.</code></p>'+
      '<textarea id="vcod" rows="5" placeholder="rehub1.…" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>'+
      '<div class="lockerr">'+esc(LOCK_MSG)+'</div><button class="btn pri" onclick="vincular()">Vincular</button>';
  } else if(LOCK_MODO==='crear'||LOCK_MODO==='repetir'||LOCK_MODO==='pin'){
    var tit={crear:'Elige un PIN de 4 cifras',repetir:'Repite el PIN',pin:'Introduce tu PIN'}[LOCK_MODO];
    h+='<h1>'+tit+'</h1><div class="dots">'+[0,1,2,3].map(function(i){return '<i class="'+(i<PIN_TMP.length?'on':'')+'"></i>';}).join('')+'</div>'+
      '<div class="lockerr">'+esc(LOCK_MSG)+'</div><div class="pad">'+
      [1,2,3,4,5,6,7,8,9].map(function(n){return '<button onclick="tecla(\''+n+'\')">'+n+'</button>';}).join('')+
      (LOCK_MODO==='pin'&&lsGet(K.fid)?'<button class="x" onclick="desbloquearFaceID()">Face ID</button>':'<span></span>')+
      '<button onclick="tecla(\'0\')">0</button><button class="x" onclick="tecla(\'del\')">Borrar</button></div>';
  } else if(LOCK_MODO==='ofrecer-fid'){
    h+='<h1>¿Activar Face ID?</h1><p>Podrás abrir la app con la cara; el PIN queda como alternativa.</p><div class="lockerr">'+esc(LOCK_MSG)+'</div>'+
      '<button class="btn pri" onclick="activarFaceID()">Activar Face ID</button><button class="btn" onclick="quitarLock()">Ahora no</button>';
  } else if(LOCK_MODO==='fid'){
    h+='<h1>RE Hub</h1><p>Desbloquea para ver tus pisos.</p><div class="lockerr">'+esc(LOCK_MSG)+'</div>'+
      '<button class="btn pri" onclick="desbloquearFaceID()">Desbloquear con Face ID</button><button class="btn" onclick="mostrarLock(\'pin\')">Usar el PIN</button>';
  }
  el.innerHTML=h;
}
function vincular(){
  var c=(document.getElementById('vcod').value||'').trim().replace(/\s+/g,'');
  try{
    if(c.indexOf('rehub1.')!==0) throw 0;
    var o=JSON.parse(new TextDecoder().decode(b64uDec(c.slice(7))));
    if(!/^https:\/\/script\.google\.com\/.+\/exec$/.test(o.api)||!o.clave) throw 0;
    LOCK_MSG='Comprobando…';pintarLock();
    lsSet(K.cfg,{api:o.api,clave:o.clave});
    api('ping').then(function(){LOCK_MSG='';mostrarLock(lsGet(K.pin)?'pin':'crear');})
      .catch(function(e){if(lsGet(K.cfg))lsDel(K.cfg);mostrarLock('vincular','No conecta con el Libro ('+e.message+'). Revisa el código y la implementación.');});
  }catch(_){LOCK_MSG='Ese código no es válido. Cópialo entero, desde «rehub1.» hasta el final.';pintarLock();}
}
function tecla(t){
  LOCK_MSG='';
  if(t==='del'){PIN_TMP=PIN_TMP.slice(0,-1);return pintarLock();}
  if(PIN_TMP.length>=4) return;
  PIN_TMP+=t; pintarLock();
  if(PIN_TMP.length<4) return;
  var p=PIN_TMP;
  setTimeout(function(){
    if(LOCK_MODO==='crear'){PIN_1=p;mostrarLock('repetir');}
    else if(LOCK_MODO==='repetir'){
      if(p!==PIN_1){PIN_1='';return mostrarLock('crear','Los PIN no coinciden. Vuelve a empezar.');}
      var sal=b64u(rnd(16));
      sha(sal+p).then(function(h){lsSet(K.pin,{sal:sal,h:h});PIN_1='';
        hayFaceID().then(function(si){if(si)mostrarLock('ofrecer-fid');else quitarLock();});});
    } else if(LOCK_MODO==='pin'){
      var st=lsGet(K.pin), it=lsGet(K.intentos)||{n:0,hasta:0};
      if(Date.now()<it.hasta) return mostrarLock('pin','Demasiados intentos. Espera '+Math.ceil((it.hasta-Date.now())/1000)+' s.');
      sha(st.sal+p).then(function(h){
        if(h===st.h){lsDel(K.intentos);quitarLock();}
        else{it.n++;if(it.n>=5){it.hasta=Date.now()+60000;it.n=0;}lsSet(K.intentos,it);mostrarLock('pin','PIN incorrecto.');}
      });
    }
  },120);
}
function activarFaceID(){
  navigator.credentials.create({publicKey:{challenge:rnd(32),rp:{name:'RE Hub'},user:{id:rnd(16),name:'RE Hub',displayName:'RE Hub'},
    pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],
    authenticatorSelection:{authenticatorAttachment:'platform',userVerification:'required',residentKey:'discouraged'},timeout:60000,attestation:'none'}})
  .then(function(c){lsSet(K.fid,{id:b64u(c.rawId)});quitarLock();})
  .catch(function(e){LOCK_MSG='No se ha podido activar ('+(e&&e.name||'error')+'). Puedes seguir con el PIN.';pintarLock();});
}
function desbloquearFaceID(){
  var f=lsGet(K.fid); if(!f) return mostrarLock('pin');
  navigator.credentials.get({publicKey:{challenge:rnd(32),allowCredentials:[{type:'public-key',id:b64uDec(f.id),transports:['internal']}],userVerification:'required',timeout:60000}})
  .then(function(){lsDel(K.intentos);quitarLock();})
  .catch(function(){mostrarLock(LOCK_MODO==='fid'?'fid':'pin','No se ha reconocido. Prueba otra vez o usa el PIN.');});
}
function pedirDesbloqueo(){
  if(!lsGet(K.cfg)) return mostrarLock('vincular');
  if(!lsGet(K.pin)) return mostrarLock('crear');
  mostrarLock(lsGet(K.fid)?'fid':'pin');
}
/* ---------- utilidades ---------- */
var MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
var MES3 = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
var DIAS = ['DOM','LUN','MAR','MIÉ','JUE','VIE','SÁB'];
var TIPOS_DEF = ['Impago','Daños / humedad','Avería / reparación','Mejora / sustitución','Queja de vecino / comunidad','Seguro / siniestro','Reclamación a tercero','Inquilino: entrada / salida / contrato','Suministros','Administrativo / documentación','Otro'];

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function objs(rows){
  if(!rows||!rows.length) return [];
  var h=rows[0];
  return rows.slice(1).filter(function(r){return r.some(function(c){return c!=='';});}).map(function(r){
    var o={}; h.forEach(function(k,i){o[k]=r[i]||'';}); return o;});
}
function key(o,pref){var ks=Object.keys(o);for(var i=0;i<ks.length;i++){if(ks[i].indexOf(pref)===0)return o[ks[i]];}return '';}
function fecha(s){
  if(!s) return null; s=String(s).trim(); var m;
  if((m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s))) return new Date(Date.UTC(+m[3],m[2]-1,+m[1]));
  if((m=/^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return new Date(Date.UTC(+m[1],m[2]-1,+m[3]));
  return null;
}
function num(s){
  if(s==null||s==='') return 0; s=String(s).replace(/[€\s\u00a0]/g,'');
  if(s.indexOf(',')>=0) s=s.replace(/\./g,'').replace(',','.');
  else if(/^-?\d{1,3}(\.\d{3})+$/.test(s)) s=s.replace(/\./g,'');
  var n=parseFloat(s); return isNaN(n)?0:n;
}
function eur(n,dec){return (n<0?'−':'')+Math.abs(n).toLocaleString('es-ES',{minimumFractionDigits:dec?2:0,maximumFractionDigits:dec?2:0,useGrouping:true})+' €';}
function dd(d){return d?('0'+d.getUTCDate()).slice(-2)+'/'+('0'+(d.getUTCMonth()+1)).slice(-2):'';}
function dias(a,b){return Math.round((b-a)/864e5);}
function corto(nombre){var p=String(nombre).split('–');return (p[1]||p[0]).trim();}

/* ---------- modelo: todo sale del Libro ---------- */
function modelo(R){
  var hoy=fecha(R.hoy), Y=hoy.getUTCFullYear(), Mo=hoy.getUTCMonth();
  var mesTxt=MESES[Mo]+' de '+Y;
  var inm=objs(R.inmuebles).filter(function(x){return x['Código']&&x['Código']!=='PERSONAL';}).map(function(x){
    return {cod:x['Código'],nombre:x.Nombre,titular:x.Titular,pct:num(x['% titularidad'])/100||1,compra:fecha(x['Fecha compra']),precio:num(x['Precio compra'])};});
  var inq=objs(R.inquilinos).filter(function(x){return x.Piso&&x.ID&&x.ID.indexOf('Leyenda')!==0;});
  var ven=objs(R.vencimientos).filter(function(x){return x.ID;}).map(function(v){v.f=fecha(v.Vence);return v;});
  var inc=objs(R.incidencias).filter(function(x){return /^INC-/.test(x.ID);}).map(function(i){i.fc=fecha(i['Fecha de control']);return i;});
  var rec=objs(R.recibos).filter(function(x){return x['Nº'];});
  var mov=objs(R.movimientos).filter(function(x){return x.Fecha;}).map(function(m){
    return {piso:m.Inmueble,f:fecha(m.Fecha),tipo:m.Tipo,cat:m['Categoría fiscal'],con:m.Concepto,cp:m.Contraparte,imp:num(m['Importe €'])};});
  var abiertas=inc.filter(function(i){return i.Estado&&i.Estado!=='Cerrada';});

  // Cobros del mes: cobrado si hay recibo del mes o ingreso de renta en Movimientos este mes.
  var cobros=inq.filter(function(i){return i.Estado==='Vigente';}).map(function(i){
    var piso=i.Piso, hab=i['Hab.']||'';
    var r=rec.filter(function(r){return r.Piso===piso&&(r['Hab.']||'')===hab&&String(key(r,'Mes')).toLowerCase().trim()===mesTxt;})[0];
    var tok=hab?new RegExp('\\b'+hab+'\\b'):null;
    var mv=mov.filter(function(m){return m.piso===piso&&m.tipo==='Ingreso'&&m.cat==='Renta'&&m.f&&m.f.getUTCFullYear()===Y&&m.f.getUTCMonth()===Mo&&m.imp>0&&(!tok||tok.test(m.con+' '+m.cp));})[0];
    var txt=i['Día de pago']||'', dia=NaN, mm;
    if((mm=/alerta el d[ií]a (\d+)/i.exec(txt))) dia=+mm[1];
    else if((mm=/(\d+)\s*[–-]\s*(\d+)/.exec(txt))) dia=+mm[2];
    else if((mm=/(\d+)/.exec(txt))) dia=+mm[1];
    var estado=(r||mv)?'cobrado':(isNaN(dia)?'sin-dia':(hoy.getUTCDate()>dia?'pendiente':'por-llegar'));
    var incid=abiertas.filter(function(x){return x.Piso===piso&&x.Tipo==='Impago'&&(!hab||x['Habitación / zona']===hab);})[0];
    var sale=fecha(i['Salida real']);
    return {piso:piso,hab:hab,nombre:i['Inquilino/a'],renta:num(i['Renta €/mes']),fin:i['Fin de contrato / prórroga'],estado:estado,dia:dia,incid:incid,sale:sale,recibo:r,fianza:num(i['Fianza €'])};
  });
  return {hoy:hoy,Y:Y,Mo:Mo,mesTxt:mesTxt,inm:inm,inq:inq,ven:ven,inc:inc,abiertas:abiertas,rec:rec,mov:mov,cobros:cobros};
}

// Resultado de explotación: ingresos + gastos + intereses (sin compra, mejoras, capital de hipoteca, fianzas ni movimientos entre socios).
function cuenta(piso,desde,hasta){
  var ing=0,gas=0;
  M.mov.forEach(function(m){
    if(m.piso!==piso||!m.f||(desde&&m.f<desde)||(hasta&&m.f>hasta)) return;
    if(m.tipo==='Ingreso') ing+=m.imp;
    else if(m.tipo==='Gasto'||m.cat==='Intereses préstamo') gas+=m.imp;
  });
  return {ing:ing,gas:gas,neto:ing+gas};
}
function prioBadge(i){var p=(i.Prioridad||'').toLowerCase();if(!p)return '';return '<span class="badge b-'+esc(p)+'">'+esc(p.toUpperCase())+'</span>';}
function ordenInc(a,b){var pa={alta:0,media:1,baja:2}[(a.Prioridad||'').toLowerCase()],pb={alta:0,media:1,baja:2}[(b.Prioridad||'').toLowerCase()];
  pa=pa==null?1.5:pa;pb=pb==null?1.5:pb;if(pa!==pb)return pa-pb;
  if(a.fc&&b.fc)return a.fc-b.fc;if(a.fc)return -1;if(b.fc)return 1;return 0;}
function cobroDeVencimiento(v){ // vencimiento de tipo Cobro ya cobrado este mes
  if(v.Tipo!=='Cobro') return false;
  var cs=M.cobros.filter(function(c){return c.piso===v.Piso;});
  return cs.length&&cs.every(function(c){return c.estado==='cobrado';});
}

/* ---------- pantallas ---------- */
function vHoy(){
  var hoy=M.hoy, en7=new Date(hoy.getTime()+7*864e5), en30=new Date(hoy.getTime()+30*864e5);
  var prox=M.ven.filter(function(v){return v.f&&v.f>=hoy&&v.f<=en7;}).sort(function(a,b){return a.f-b.f;});
  var desp=M.ven.filter(function(v){return v.f&&v.f>en7&&v.f<=en30;}).sort(function(a,b){return a.f-b.f;});
  var sinF=M.ven.filter(function(v){return v.Estado==='Falta fecha';});
  var pend=M.cobros.filter(function(c){return c.estado==='pendiente';});
  var sinDia=M.cobros.filter(function(c){return c.estado==='sin-dia';});
  var vencNoHechos=prox.filter(function(v){return !cobroDeVencimiento(v);}).length;
  var h='<div class="top"><div class="fecha">'+DIAS[hoy.getUTCDay()].charAt(0)+DIAS[hoy.getUTCDay()].slice(1).toLowerCase()+', '+hoy.getUTCDate()+' de '+MESES[hoy.getUTCMonth()]+'</div>'+
    '<div class="row"><h1 class="sp">Hoy</h1><button class="back" onclick="cargar(true)" aria-label="Actualizar"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#17201B" stroke-width="2" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg></button></div></div>';
  h+='<div class="tiles"><button class="tile" onclick="ir(\'#semana\')"><b>'+vencNoHechos+'</b><span>vencen en 7 días</span></button>'+
     '<button class="tile'+(pend.length?' warn':'')+'" onclick="ir(\'#cobros\')"><b>'+pend.length+'</b><span>'+(pend.length===1?'cobro pendiente':'cobros pendientes')+'</span></button>'+
     '<button class="tile" onclick="nav(\'inc\')"><b>'+M.abiertas.length+'</b><span>incidencias abiertas</span></button></div>';
  // Próximos 7 días
  h+='<div class="sec" id="semana"><div class="sech"><h2>Próximos 7 días</h2></div><div class="card list">';
  if(!prox.length) h+='<div class="empty">Nada que venza esta semana.</div>';
  prox.forEach(function(v){
    var hecho=cobroDeVencimiento(v);
    var dch=hecho?'<span class="amt ok">Cobrada ✓</span>':(num(v['Importe aprox. €'])?'<span class="amt">'+eur(num(v['Importe aprox. €']))+'</span>':'');
    h+='<div class="it"><div class="day"><span>'+DIAS[v.f.getUTCDay()]+'</span><b>'+v.f.getUTCDate()+'</b></div><div class="sp"><div class="t clamp">'+esc(v.Concepto)+'</div><div class="s">'+esc(v.Piso)+' · '+esc(v.Tipo)+'</div></div>'+dch+'</div>';
  });
  h+='</div>';
  if(desp.length) h+='<div class="note">Después: '+desp.slice(0,3).map(function(v){return esc(v.Concepto.split(/[(:]/)[0].trim())+' ('+dd(v.f)+')';}).join(' · ')+'</div>';
  if(sinF.length) h+='<div class="note warn">'+sinF.length+' vencimientos sin fecha: '+sinF.map(function(v){return esc(v.Piso+' '+v.Tipo.toLowerCase());}).join(', ')+'</div>';
  h+='</div>';
  // Cobros
  h+='<div class="sec" id="cobros"><h2>Cobros sin ver en el banco · '+MESES[M.Mo]+'</h2>';
  if(!pend.length) h+='<div class="card empty">Todo lo vencido de '+MESES[M.Mo]+' está cobrado según el banco ✓</div>';
  pend.forEach(function(c){
    var extra=[];
    if(c.sale) extra.push(c.sale<=M.hoy?'Sale el '+dd(c.sale):'Sale el '+dd(c.sale));
    extra.push('pago hacia el día '+c.dia);
    h+='<div class="card" style="border-color:var(--warnln)"><div class="list"><div class="it"><span class="dot" style="background:#C2570C"></span><div class="sp"><div class="t">'+esc(c.nombre.split(' ')[0])+(c.hab?' · '+esc(c.hab):'')+'</div><div class="s">'+esc(c.piso)+' · '+extra.join(' · ')+'</div></div><span class="amt">'+eur(c.renta)+'</span></div>'+
      (c.incid?'<div class="it" onclick="verInc(\''+c.incid.ID+'\')"><div class="sp"><div class="s"><b>'+esc(c.incid.ID)+' · '+esc(c.incid.Estado)+'</b></div><div class="s clamp">'+esc(c.incid['Siguiente paso'])+'</div></div></div>':'')+
      '</div></div>';
  });
  var bh=bancoHasta(); if(pend.length&&bh) h+='<div class="note">Banco conciliado hasta el '+dd(bh)+'. Lo cobrado después aparece tras el barrido del día 11.</div>';
  if(sinDia.length) h+='<div class="note">Sin día de pago en Inquilinos: '+sinDia.map(function(c){return esc(c.piso+(c.hab?' '+c.hab:''));}).join(', ')+'</div>';
  h+='</div>';
  // Recibos nuevos (últimos 15 días)
  var hace15=new Date(M.hoy.getTime()-15*864e5);
  var rn=M.rec.filter(function(r){var f=fecha(r['Fecha cobro']);return r.PDF&&f&&f>=hace15;}).sort(function(a,b){return fecha(b['Fecha cobro'])-fecha(a['Fecha cobro']);});
  if(rn.length){h+='<div class="sec"><h2>Recibos nuevos</h2><div class="card list">';rn.forEach(function(r){h+=filaRecibo(r,true);});h+='</div></div>';}
  // Incidencias
  var top=M.abiertas.slice().sort(ordenInc).slice(0,3);
  h+='<div class="sec"><div class="sech"><h2>Incidencias abiertas</h2><button onclick="nav(\'inc\')">Las '+M.abiertas.length+'</button></div><div class="card list">';
  top.forEach(function(i){h+=filaInc(i,false);});
  if(!top.length) h+='<div class="empty">No hay incidencias abiertas.</div>';
  h+='</div></div>'+pie();
  return h+'<button class="fab" onclick="nueva()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Incidencia</button>';
}

function filaInc(i,det){
  var ctl=i.fc?(' · control '+dd(i.fc)):'';
  var tarde=i.fc&&i.fc<M.hoy?' bad':'';
  return '<div class="it" style="flex-direction:column;align-items:stretch;gap:0;padding:0" id="i-'+i.ID+'"><div class="row" style="padding:12px 14px;align-items:flex-start" onclick="this.parentNode.classList.toggle(\'open\')">'+
    prioBadge(i)+'<div class="sp"><div class="t">'+esc(i['Descripción'])+'</div><div class="s'+tarde+'">'+esc(i.ID)+' · '+esc(i.Piso)+(i['Habitación / zona']&&i['Habitación / zona']!=='—'?' · '+esc(i['Habitación / zona']):'')+' · '+esc(i.Estado)+ctl+'</div></div></div>'+
    '<div class="det">'+(i['Siguiente paso']?'<div><b>Siguiente paso:</b> '+esc(i['Siguiente paso'])+'</div>':'')+
    (i['Afecta a / contraparte']&&i['Afecta a / contraparte']!=='—'?'<div><b>Contraparte:</b> '+esc(i['Afecta a / contraparte'])+'</div>':'')+
    (i.Responsable?'<div><b>Responsable:</b> '+esc(i.Responsable)+'</div>':'')+
    (num(i['Importe €'])?'<div><b>Importe:</b> '+eur(num(i['Importe €']),true)+'</div>':'')+
    (/^https?:/.test(i.Enlace)?'<div><a href="'+esc(i.Enlace)+'" target="_blank">Abrir adjunto</a></div>':'')+
    '<div class="btns" style="margin-top:8px"><button class="btn" onclick="editarInc(\''+i.ID+'\')">Editar</button><button class="btn" onclick="editarInc(\''+i.ID+'\',true)">Cerrar incidencia</button></div></div></div>';
}

function estadoPiso(cod){
  var cs=M.cobros.filter(function(c){return c.piso===cod;});
  if(!cs.length) return '<span class="pill p-mut">Sin inquilinos</span>';
  var p=cs.filter(function(c){return c.estado==='pendiente';}).length;
  if(p) return '<span class="pill p-warn">'+p+' impago'+(p>1?'s':'')+'</span>';
  if(cs.every(function(c){return c.estado==='cobrado';})) return '<span class="pill p-ok">Cobrado</span>';
  return '<span class="pill p-mut">Por llegar</span>';
}

function vPisos(){
  var ini=new Date(Date.UTC(M.Y,0,1));
  var h='<div class="top"><h1>Mis pisos</h1></div><div class="sec" style="padding-top:4px;gap:10px">';
  M.inm.forEach(function(p){
    var cs=M.cobros.filter(function(c){return c.piso===p.cod;});
    var renta=cs.reduce(function(s,c){return s+c.renta;},0);
    var n=M.abiertas.filter(function(i){return i.Piso===p.cod;}).length;
    var r=cuenta(p.cod,ini,null);
    var sub=cs.length===1?esc(cs[0].nombre.split(' ')[0])+' · '+esc(String(cs[0].fin).split(/[;(]/)[0]):(cs.length?cs.length+' habitaciones alquiladas':esc(p.titular));
    var pend=cs.some(function(c){return c.estado==='pendiente';});
    h+='<button class="card piso" style="'+(pend?'border-color:var(--warnln)':'')+'" onclick="ficha(\''+p.cod+'\')"><div class="row" style="align-items:flex-start"><div class="sp"><div class="code">'+esc(p.cod)+(p.pct<1?' · '+Math.round(p.pct*100)+' %':'')+'</div><div style="font-size:16px;font-weight:600">'+esc(corto(p.nombre))+'</div><div class="s">'+sub+'</div></div>'+estadoPiso(p.cod)+'</div>'+
      '<div class="stats"><div><span>Renta/mes</span><b>'+(renta?eur(renta):'—')+'</b></div><div><span>'+(p.pct<1?'Tu parte, ':'Resultado ')+M.Y+'</span><b>'+(r.ing||r.gas?eur(r.neto*p.pct):'—')+'</b></div><div><span>Incidencias</span><b class="'+(n>2?'bad':'')+'">'+n+'</b></div></div></button>';
  });
  return h+'</div>'+pie()+'<button class="fab" onclick="nueva()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Incidencia</button>';
}

function vFicha(cod,per){
  var p=M.inm.filter(function(x){return x.cod===cod;})[0]; if(!p) return vPisos();
  per=per||'mes';
  var hoy=M.hoy, desde, etiqueta;
  if(per==='mes'){desde=new Date(Date.UTC(M.Y,M.Mo,1));etiqueta=MESES[M.Mo];}
  else if(per==='año'){desde=new Date(Date.UTC(M.Y,0,1));etiqueta=String(M.Y);}
  else {desde=p.compra;etiqueta=p.compra?'desde '+dd(p.compra)+'/'+p.compra.getUTCFullYear():'todo el histórico';}
  var r=cuenta(cod,desde,null);
  // 6 meses
  var meses=[],mx=1;
  for(var k=5;k>=0;k--){var a=new Date(Date.UTC(M.Y,M.Mo-k,1)),b=new Date(Date.UTC(M.Y,M.Mo-k+1,0));var c=cuenta(cod,a,b);meses.push({l:MES3[a.getUTCMonth()],i:c.ing,g:-c.gas});mx=Math.max(mx,c.ing,-c.gas);}
  var cs=M.cobros.filter(function(c){return c.piso===cod;});
  var renta=cs.reduce(function(s,c){return s+c.renta;},0);
  var h='<div class="top" style="padding-top:16px"><div class="row"><button class="back" onclick="nav(\'pisos\')" aria-label="Volver"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#17201B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button><div class="sp"><div class="code">'+esc(cod)+(p.pct<1?' · '+Math.round(p.pct*100)+' %':'')+'</div><div style="font-size:18px;font-weight:600">'+esc(p.nombre)+'</div></div></div></div>';
  h+='<div class="seg">'+['mes','año','compra'].map(function(x){return '<button class="'+(x===per?'on':'')+'" onclick="ficha(\''+cod+'\',\''+x+'\')">'+({mes:'Mes','año':'Año',compra:'Desde compra'})[x]+'</button>';}).join('')+'</div>';
  h+='<div class="sec"><div class="card" style="padding:14px;display:flex;flex-direction:column;gap:12px"><div class="stats" style="border:0;padding:0"><div><span>Ingresos</span><b>'+eur(r.ing)+'</b></div><div><span>Gastos</span><b>'+eur(-r.gas)+'</b></div><div><span>Resultado</span><b class="'+(r.neto>=0?'ok':'bad')+'">'+eur(r.neto)+'</b></div></div>'+
    (p.pct<1?'<div class="s">Tu parte ('+Math.round(p.pct*100)+' %): <b>'+eur(r.neto*p.pct)+'</b></div>':'')+
    '<div class="bars">'+meses.map(function(m){return '<div><i style="height:'+Math.round(m.i/mx*100)+'%;background:#0E6B58"></i><i style="height:'+Math.round(m.g/mx*100)+'%;background:#E8A26F"></i></div>';}).join('')+'</div>'+
    '<div class="lbls">'+meses.map(function(m){return '<span>'+m.l+'</span>';}).join('')+'</div>'+
    '<div class="row s"><span class="sp">'+(renta&&p.precio?'Rentabilidad bruta s/ compra: '+(renta*12/p.precio*100).toFixed(1).replace('.',',')+' %':'')+'</span><span>'+esc(etiqueta)+'</span></div>'+
    '<div class="s" style="font-size:11px">Resultado = ingresos − gastos e intereses. No incluye compra, mejoras, capital de la hipoteca ni fianzas.</div></div></div>';
  // Inquilinos
  h+='<div class="sec"><h2>'+(cs.length>1?'Inquilinos':'Inquilino/a y contrato')+'</h2><div class="card list">';
  if(!cs.length) h+='<div class="empty">Sin inquilinos vigentes en el Libro.</div>';
  cs.forEach(function(c){
    var st={cobrado:'<span class="pill p-ok">Cobrado</span>',pendiente:'<span class="pill p-warn">Pendiente</span>','por-llegar':'<span class="pill p-mut">Por llegar</span>','sin-dia':'<span class="pill p-mut">Sin día de pago</span>'}[c.estado];
    h+='<div class="it"><div class="sp"><div class="t">'+(c.hab?esc(c.hab)+' · ':'')+esc(c.nombre)+' · '+eur(c.renta)+'/mes</div><div class="s clamp">'+(c.fin?esc(String(c.fin).split(/[;(]/)[0]):'')+(c.sale?' Sale el '+dd(c.sale):'')+'</div></div>'+st+'</div>';
  });
  h+='</div></div>';
  // Vencimientos
  var vs=M.ven.filter(function(v){return v.Piso===cod&&(v.Estado==='Falta fecha'||(v.f&&v.f>=hoy));}).sort(function(a,b){return (a.f||9e15)-(b.f||9e15);}).slice(0,6);
  h+='<div class="sec"><h2>Próximos vencimientos</h2><div class="card list">';
  if(!vs.length) h+='<div class="empty">Ninguno.</div>';
  vs.forEach(function(v){
    var d=v.Estado==='Falta fecha'?'<span class="s warn">Falta fecha</span>':(cobroDeVencimiento(v)?'<span class="s ok">Cobrada ✓</span>':'<span class="s">'+dd(v.f)+'/'+String(v.f.getUTCFullYear()).slice(2)+'</span>');
    h+='<div class="it"><div class="sp t clamp" style="font-weight:400">'+esc(v.Concepto)+'</div>'+d+'</div>';
  });
  h+='</div></div>';
  // Recibos del piso
  var rs=M.rec.filter(function(r){return r.Piso===cod&&r.PDF;}).sort(function(a,b){return fecha(b['Fecha cobro'])-fecha(a['Fecha cobro']);});
  h+='<div class="sec"><h2>Recibos</h2><div class="card list">';
  rs.slice(0,VISTA.todosRec?999:4).forEach(function(r){h+=filaRecibo(r,cs.length>1);});
  if(!rs.length) h+='<div class="empty">Todavía no hay recibos de este piso.</div>';
  h+='</div>'+(rs.length>4&&!VISTA.todosRec?'<button class="btn" onclick="VISTA.todosRec=true;pintar()">Ver los '+rs.length+' recibos</button>':'')+'</div>';
  // Incidencias del piso
  var is=M.abiertas.filter(function(i){return i.Piso===cod;}).sort(ordenInc);
  h+='<div class="sec"><h2>Incidencias abiertas ('+is.length+')</h2><div class="card list">';
  is.forEach(function(i){h+=filaInc(i,false);});
  if(!is.length) h+='<div class="empty">Ninguna.</div>';
  h+='</div><div class="btns"><a class="btn" href="'+esc(RAW.libroUrl)+'" target="_blank">Abrir el Libro</a><button class="btn pri" onclick="nueva(\''+cod+'\')">+ Incidencia</button></div></div>'+pie();
  return h;
}

function vInc(filtro){
  var pisos=['Todos'].concat(M.inm.map(function(p){return p.cod;})).concat(['—']);
  var is=M.abiertas.filter(function(i){return !filtro||filtro==='Todos'||i.Piso===filtro;}).sort(ordenInc);
  var h='<div class="top"><h1>Incidencias</h1><div class="s">'+M.abiertas.length+' abiertas · toca una para ver el siguiente paso</div></div>';
  h+='<div class="sec"><div class="chips">'+pisos.map(function(p){return '<button class="'+((filtro||'Todos')===p?'on':'')+'" onclick="VISTA={t:\'inc\',f:\''+p+'\'};pintar()">'+(p==='—'?'General':p)+'</button>';}).join('')+'</div>';
  h+='<div class="card list">';
  is.forEach(function(i){h+=filaInc(i,false);});
  if(!is.length) h+='<div class="empty">Ninguna.</div>';
  h+='</div></div>'+pie();
  return h+'<button class="fab" onclick="nueva()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Incidencia</button>';
}


function filaRecibo(r,conNombre){
  var u=r.PDF, k=RECIBO_CACHE[u]?'Compartir':'Enviar';
  var est=PREP[u]?'Preparando…':k;
  return '<div class="it"><div class="sp"><div class="t">'+esc(String(key(r,'Mes')).replace(/ de \d{4}$/,'').replace(/^./,function(c){return c.toUpperCase();}))+' · '+esc(r['Importe €'])+'</div><div class="s">'+
    (conNombre?esc((r['Hab.']?r['Hab.']+' · ':'')+String(r.Inquilino).split(' ')[0])+' · ':'')+esc(r.Piso)+' · cobrado el '+esc(r['Fecha cobro'])+'</div></div>'+
    '<button class="pill p-ok" style="border:0;padding:8px 12px" '+(PREP[u]?'disabled':'')+' onclick="enviarRecibo(\''+esc(u)+'\',\''+esc(r['Nº'])+'\')">'+est+'</button></div>';
}
function bancoHasta(){
  var mx=null; M.mov.forEach(function(m){if(m.f&&m.f<=M.hoy&&(!mx||m.f>mx))mx=m.f;}); return mx;
}
/* ---------- alta de incidencia (con cola sin conexión) ---------- */
var F=null;
function vNueva(){
  var tipos=(RAW.tiposIncidencia&&RAW.tiposIncidencia.length)?RAW.tiposIncidencia:TIPOS_DEF;
  window.TIPOS=tipos;
  var pisos=M.inm.map(function(p){return p.cod;}).concat(['—']);
  if(F.ok){
    var txt=(F.ok.id||'Incidencia')+' · '+(F.piso==='—'?'General':F.piso)+(F.zona?' · '+F.zona:'')+': '+F.desc+(F.ok.enlace?'\n'+F.ok.enlace:'');
    return '<div class="form"><div style="text-align:center;padding:40px 0 10px"><div style="font-size:44px">'+(F.ok.cola?'⏳':'✓')+'</div><h1 style="font-size:22px">'+
      (F.ok.cola?'Guardada en el móvil':'Guardada como '+esc(F.ok.id))+'</h1><div class="s" style="margin-top:6px">'+
      (F.ok.cola?'No hay conexión con el Libro. Se enviará sola en cuanto vuelva internet y entonces recibirá su número INC-.':'Ya está en la pestaña Incidencias del Libro'+(F.ok.enlace?' y el adjunto en Drive (00_App_Adjuntos)':'')+'.')+'</div></div>'+
      '<a class="btn" href="https://wa.me/?text='+encodeURIComponent(txt)+'">Enviar por WhatsApp…</a>'+
      '<button class="btn pri" onclick="nav(\'hoy\')">Volver a Hoy</button></div>';
  }
  var h='<div class="form"><div class="row"><button style="background:none;border:0;color:var(--ok);font-size:15px;min-height:44px;padding:0" onclick="volver()">Cancelar</button><h2 class="sp" style="text-align:center;font-size:17px">Nueva incidencia</h2><span style="width:60px"></span></div>';
  if(!navigator.onLine) h+='<div class="info" style="margin:0">Sin conexión: se guardará en el móvil y se enviará al Libro cuando vuelva internet.</div>';
  h+='<div><label class="f" for="desc">¿Qué ha pasado?</label><textarea id="desc" rows="3" placeholder="Escríbelo o díctalo con el micrófono del teclado" oninput="F.desc=this.value">'+esc(F.desc)+'</textarea></div>';
  h+='<div><label class="f">Piso</label><div class="chips">'+pisos.map(function(p){return '<button class="'+(F.piso===p?'on':'')+'" onclick="F.piso=\''+p+'\';pintar()">'+(p==='—'?'General':p)+'</button>';}).join('')+'</div></div>';
  h+='<div><label class="f" for="zona">Habitación o zona <span class="s">(opcional)</span></label><input type="text" id="zona" placeholder="Ej.: H4, baño, cocina" value="'+esc(F.zona)+'" oninput="F.zona=this.value"></div>';
  h+='<div><label class="f">Tipo</label><div class="chips">'+tipos.map(function(t,k){return '<button class="'+(F.tipo===t?'on':'')+'" onclick="F.tipo=TIPOS['+k+'];pintar()">'+esc(t)+'</button>';}).join('')+'</div></div>';
  h+='<div><label class="f">Prioridad</label><div class="seg" style="margin:0">'+['Alta','Media','Baja'].map(function(x){return '<button class="'+(F.prioridad===x?'on':'')+'" onclick="F.prioridad=\''+x+'\';pintar()">'+x+'</button>';}).join('')+'</div></div>';
  h+='<div><label class="f" for="sig">Siguiente paso <span class="s">(opcional)</span></label><input type="text" id="sig" value="'+esc(F.siguiente)+'" oninput="F.siguiente=this.value"></div>';
  h+='<div><label class="f" for="ctl">Fecha de control <span class="s">(opcional)</span></label><input type="date" id="ctl" value="'+esc(F.control)+'" onchange="F.control=this.value"></div>';
  h+='<div><label class="f">Adjunto <span class="s">(foto o factura)</span></label><label class="btn" style="border-style:dashed;border-width:1.5px;border-color:#B9C0BA">'+(F.adjunto?'✓ '+esc(F.adjNombre):'📷 Foto o archivo')+'<input type="file" accept="image/*,application/pdf" style="display:none" onchange="adjuntar(this)"></label></div>';
  if(F.err) h+='<div class="err" style="margin:0">'+esc(F.err)+'</div>';
  h+='<button class="btn pri" style="height:54px;font-size:16px" '+(F.guardando?'disabled':'')+' onclick="guardar()">'+(F.guardando?'Guardando…':'Guardar incidencia')+'</button></div>';
  return h;
}
function nueva(piso){F={uid:uid(),piso:piso||'',zona:'',tipo:'',desc:'',prioridad:'Media',siguiente:'',control:'',adjunto:null};VISTA={t:'nueva',prev:VISTA};pintar();window.scrollTo(0,0);}
function volver(){VISTA=VISTA.prev||{t:'hoy'};pintar();}
function adjuntar(inp){
  var f=inp.files&&inp.files[0]; if(!f) return;
  F.adjNombre=f.name||'archivo';
  if(/^image\//.test(f.type)){
    var img=new Image(), url=URL.createObjectURL(f);
    img.onload=function(){var max=1600,s=Math.min(1,max/Math.max(img.width,img.height));var c=document.createElement('canvas');c.width=Math.round(img.width*s);c.height=Math.round(img.height*s);c.getContext('2d').drawImage(img,0,0,c.width,c.height);
      F.adjunto={b64:c.toDataURL('image/jpeg',0.82).split(',')[1],mime:'image/jpeg',ext:'jpg'};F.adjNombre='foto ('+Math.round(F.adjunto.b64.length*0.75/1024)+' KB)';URL.revokeObjectURL(url);pintar();};
    img.onerror=function(){F.err='No se pudo leer la foto.';pintar();};
    img.src=url;
  } else {
    var rd=new FileReader();rd.onload=function(){F.adjunto={b64:String(rd.result).split(',')[1],mime:f.type||'application/pdf',ext:(f.name.split('.').pop()||'pdf').toLowerCase()};pintar();};rd.readAsDataURL(f);
  }
}
function guardar(){
  F.err='';
  if(!F.desc.trim()){F.err='Escribe qué ha pasado.';return pintar();}
  if(!F.piso){F.err='Elige el piso.';return pintar();}
  if(!F.tipo){F.err='Elige el tipo.';return pintar();}
  var item={uid:F.uid,piso:F.piso,zona:F.zona.trim(),tipo:F.tipo,desc:F.desc.trim(),prioridad:F.prioridad,siguiente:F.siguiente.trim(),control:F.control,creada:hoyISO(),adjunto:F.adjunto};
  var aCola=function(){return colaPoner(item).then(function(){F.guardando=false;F.ok={cola:true};pintar();})
    .catch(function(e){F.guardando=false;F.err='No se ha podido guardar ni en el móvil: '+e.message;pintar();});};
  F.guardando=true;pintar();
  if(!navigator.onLine) return aCola();
  api('incidencia',item).then(function(j){F.guardando=false;F.ok=j.res;pintar();cargar(false);})
    .catch(function(){ aCola(); });
}

/* ---------- recibos: enviar el PDF desde el móvil ---------- */
var RECIBO_CACHE={}, PREP={};
function compartir(u,file){
  if(navigator.canShare&&navigator.canShare({files:[file]})){
    return navigator.share({files:[file],title:file.name}).catch(function(e){ if(e&&e.name==='NotAllowedError'){avisar('Recibo listo: pulsa «Compartir».');} });
  }
  window.open(u,'_blank');
  return Promise.resolve();
}
function enviarRecibo(u,num){
  if(RECIBO_CACHE[u]) return compartir(u,RECIBO_CACHE[u]);
  if(!navigator.onLine) return avisar('Sin conexión: el recibo no está guardado en el móvil.');
  PREP[u]=true; pintar();
  api('recibo',{url:u}).then(function(j){
    var b=atob(j.res.b64), a=new Uint8Array(b.length); for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);
    RECIBO_CACHE[u]=new File([a],j.res.nombre||(num+'.pdf'),{type:j.res.mime||'application/pdf'});
    delete PREP[u]; pintar();
    return compartir(u,RECIBO_CACHE[u]);
  }).catch(function(e){delete PREP[u];ULT_ERR='No he podido traer el recibo: '+e.message;pintar();});
}

/* ---------- editar y cerrar incidencias (necesita conexión) ---------- */
var E=null;
function isoDe(s){var d=fecha(s);return d?d.toISOString().slice(0,10):'';}
function editarInc(id,cerrar){
  var i=M.inc.filter(function(x){return x.ID===id;})[0]; if(!i) return;
  E={id:id,cerrar:!!cerrar,i:i,estado:i.Estado||'Abierta',siguiente:i['Siguiente paso']||'',control:isoDe(i['Fecha de control']),prioridad:i.Prioridad||'',cierre:''};
  VISTA={t:'editar',prev:VISTA}; pintar(); window.scrollTo(0,0);
}
function vEditar(){
  var i=E.i;
  var h='<div class="form"><div class="row"><button style="background:none;border:0;color:var(--ok);font-size:15px;min-height:44px;padding:0" onclick="volver()">Cancelar</button><h2 class="sp" style="text-align:center;font-size:17px">'+(E.cerrar?'Cerrar ':'Editar ')+esc(E.id)+'</h2><span style="width:60px"></span></div>';
  h+='<div class="card" style="padding:12px 14px"><div class="t">'+esc(i['Descripción'])+'</div><div class="s">'+esc(i.Piso)+' · '+esc(i.Tipo)+'</div></div>';
  if(!navigator.onLine) h+='<div class="info" style="margin:0">Sin conexión: para cambiar una incidencia hace falta internet.</div>';
  if(E.cerrar){
    h+='<div><label class="f" for="cie">¿Cómo se ha resuelto?</label><textarea id="cie" rows="4" placeholder="Ej.: arreglado por el fontanero; factura enlazada" oninput="E.cierre=this.value">'+esc(E.cierre)+'</textarea><div class="s" style="margin-top:6px">Queda en «Cierre / resultado» con la fecha de hoy y la incidencia pasa a Cerrada.</div></div>';
  } else {
    h+='<div><label class="f">Estado</label><div class="chips">'+['Abierta','En curso','Esperando a tercero'].map(function(x){return '<button class="'+(E.estado===x?'on':'')+'" onclick="E.estado=\''+x+'\';pintar()">'+x+'</button>';}).join('')+'</div></div>';
    h+='<div><label class="f" for="esig">Siguiente paso</label><textarea id="esig" rows="4" oninput="E.siguiente=this.value">'+esc(E.siguiente)+'</textarea></div>';
    h+='<div><label class="f" for="ectl">Fecha de control</label><input type="date" id="ectl" value="'+esc(E.control)+'" onchange="E.control=this.value"></div>';
    h+='<div><label class="f">Prioridad</label><div class="seg" style="margin:0">'+['Alta','Media','Baja'].map(function(x){return '<button class="'+(E.prioridad===x?'on':'')+'" onclick="E.prioridad=\''+x+'\';pintar()">'+x+'</button>';}).join('')+'</div></div>';
  }
  if(E.err) h+='<div class="err" style="margin:0">'+esc(E.err)+'</div>';
  h+='<button class="btn pri" style="height:54px;font-size:16px" '+(E.guardando||!navigator.onLine?'disabled':'')+' onclick="guardarEdicion()">'+(E.guardando?'Guardando…':(E.cerrar?'Cerrar incidencia':'Guardar cambios'))+'</button></div>';
  return h;
}
function guardarEdicion(){
  E.err='';
  var d={id:E.id};
  if(E.cerrar){ if(!E.cierre.trim()){E.err='Escribe cómo se ha resuelto.';return pintar();} d.estado='Cerrada'; d.cierre=E.cierre.trim(); }
  else { d.estado=E.estado; d.siguiente=E.siguiente.trim(); d.control=E.control; d.prioridad=E.prioridad; }
  E.guardando=true; pintar();
  api('editarIncidencia',d).then(function(){E=null;VISTA={t:'inc'};avisar('Incidencia '+d.id+(d.estado==='Cerrada'?' cerrada.':' actualizada.'));cargar();})
    .catch(function(e){E.guardando=false;E.err='No se ha guardado: '+e.message;pintar();});
}

/* ---------- navegación, carga y arranque ---------- */
function haceCuanto(iso){
  if(!iso) return '';
  var d=new Date(iso), min=Math.round((Date.now()-d)/60000);
  if(isNaN(min)) return '';
  if(min<1) return 'ahora mismo'; if(min<60) return 'hace '+min+' min';
  var h=Math.round(min/60); if(h<24) return 'hace '+h+' h';
  return 'el '+('0'+d.getDate()).slice(-2)+'/'+('0'+(d.getMonth()+1)).slice(-2)+' a las '+('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2);
}
function pie(){
  var t='Libro leído '+haceCuanto(RAW&&RAW.leido)+(CARGANDO?' · actualizando…':'');
  if(COLA.length) t+=' · '+COLA.length+' incidencia'+(COLA.length>1?'s':'')+' pendiente'+(COLA.length>1?'s':'')+' de enviar';
  return '<div class="fresh">'+esc(t)+'</div>';
}
function cabecera(){
  var h='';
  if(!navigator.onLine) h+='<div class="info">Sin conexión. Ves el Libro tal como estaba '+esc(haceCuanto(RAW&&RAW.leido))+'. Puedes apuntar incidencias: se enviarán al volver internet.</div>';
  else if(COLA.length) h+='<div class="info">'+COLA.length+' incidencia'+(COLA.length>1?'s':'')+' guardada'+(COLA.length>1?'s':'')+' en el móvil. <a href="#" onclick="colaEnviar();return false">Enviar ahora</a></div>';
  if(AVISO) h+='<div class="info" style="background:var(--okbg);color:#0A5242">'+esc(AVISO)+'</div>';
  if(ULT_ERR) h+='<div class="err">'+esc(ULT_ERR)+'</div>';
  return h;
}
function nav(t){VISTA={t:t};pintar();window.scrollTo(0,0);}
function ficha(cod,per){VISTA={t:'ficha',cod:cod,per:per||'mes'};pintar();if(!per)window.scrollTo(0,0);}
function verInc(id){nav('inc');setTimeout(function(){var e=document.getElementById('i-'+id);if(e){e.classList.add('open');e.scrollIntoView({block:'center'});}},30);}
function ir(sel){var e=document.querySelector(sel);if(e)e.scrollIntoView({behavior:'smooth',block:'start'});}
function pintar(){
  if(LOCK_MODO) return;
  var app=document.getElementById('app');
  if(!M){app.innerHTML=cabecera()+'<div class="load">'+(navigator.onLine?'Leyendo el Libro…':'Sin conexión y sin datos guardados todavía.')+'</div>';return;}
  var y=window.scrollY, h;
  try{
    h={hoy:vHoy,pisos:vPisos,inc:function(){return vInc(VISTA.f);},ficha:function(){return vFicha(VISTA.cod,VISTA.per);},nueva:vNueva,editar:vEditar}[VISTA.t]();
  }catch(e){h='<div class="err">Error al pintar la pantalla: '+esc(e.message)+'</div>';}
  if(VISTA.t!=='nueva'&&VISTA.t!=='editar') h=cabecera()+h;
  var foco=document.activeElement&&document.activeElement.id;
  app.innerHTML=h;
  if(foco&&document.getElementById(foco)){var el=document.getElementById(foco);el.focus();if(el.setSelectionRange&&el.value)try{el.setSelectionRange(el.value.length,el.value.length);}catch(_){}}
  window.scrollTo(0,y);
  document.getElementById('nav').style.display=(VISTA.t==='nueva'||VISTA.t==='editar')?'none':'grid';
  var tab=VISTA.t==='ficha'?'pisos':VISTA.t;
  Array.prototype.forEach.call(document.querySelectorAll('nav button'),function(b){b.classList.toggle('on',b.getAttribute('data-t')===tab);});
}
function usar(raw){raw.hoy=hoyISO();RAW=raw;M=modelo(raw);pintar();}
function cargar(){
  if(!navigator.onLine||CARGANDO) return pintar();
  CARGANDO=true; pintar();
  api('datos').then(function(j){
    CARGANDO=false; ULT_ERR='';
    var raw=j.datos; if(!lsSet(K.datos,raw)) ULT_ERR='';
    usar(raw);
  }).catch(function(e){
    CARGANDO=false;
    if(!/no-autorizado|sin-vincular/.test(e.message)) ULT_ERR='No he podido leer el Libro ('+e.message+'). Ves los últimos datos guardados.';
    pintar();
  });
}
var ARRANCADA=false;
function arrancar(){
  if(!ARRANCADA){
    ARRANCADA=true;
    var c=lsGet(K.datos); if(c) usar(c);
  }
  pintar();
  colaLeer().then(function(){pintar();colaEnviar();});
  cargar();
}

Array.prototype.forEach.call(document.querySelectorAll('nav button'),function(b){b.onclick=function(){nav(b.getAttribute('data-t'));};});
window.addEventListener('online',function(){pintar();colaEnviar();cargar();});
window.addEventListener('offline',pintar);
var OCULTA=0;
document.addEventListener('visibilitychange',function(){
  if(document.hidden){OCULTA=Date.now();return;}
  if(LOCK_MODO) return;
  if(OCULTA&&Date.now()-OCULTA>BLOQUEO_MIN*60000){ pedirDesbloqueo(); }
  else { colaEnviar(); if(OCULTA&&Date.now()-OCULTA>60000) cargar(); }
});
if('serviceWorker' in navigator){navigator.serviceWorker.register('sw.js').catch(function(){});}
pedirDesbloqueo();
