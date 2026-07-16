/**
 * devkit-hardware.js — the only test of the XBDM port that proves anything.
 *
 * Everything else about devkit was verified against a stub I wrote, which can
 * only ever confirm that both implementations read my guess the same way. A real
 * console splits packets where it likes, cases its fields how it likes, and
 * answers with drives and kernels nobody invented. This runs the last
 * socket-based TypeScript and the current C-backed class against one, and
 * compares.
 *
 * Needs a devkit. Pass its IP:
 *     node core/test/devkit-hardware.js 192.168.137.7
 * It skips, loudly, when none is given — a hardware test that silently passes
 * without hardware is the worst kind.
 *
 * Retires with src/main/_ts-backup/devkit.ts.bak: once that is gone there is no
 * old implementation to disagree with.
 */
const path=require('path'), fs=require('fs');
const R=process.cwd();
const IP = process.argv[2];
if (!IP) {
    console.log('  SKIPPED - no devkit IP given.');
    console.log('  Power one on and run: node core/test/devkit-hardware.js <ip>');
    console.log('  Nothing about the XBDM port is proven without it.');
    process.exit(0);
}
const {Toolchain}=require(path.join(R,'dist','main','toolchain.js'));
const {DevkitManager:NewDm}=require(path.join(R,'dist','main','devkit.js'));

// The last socket-based TypeScript, for comparison.
const tsc=require(path.join(R,'node_modules','typescript'));
const tmp=path.join(R,'dist','main','_devkit_old.js');
fs.writeFileSync(tmp, tsc.transpileModule(
  fs.readFileSync(path.join(R,'src','main','_ts-backup','devkit.ts.bak'),'utf8'),
  {compilerOptions:{module:tsc.ModuleKind.CommonJS,target:tsc.ScriptTarget.ES2020}}).outputText);
const {DevkitManager:OldDm}=require(tmp);

const tc=new Toolchain();
const mk=(C)=>{ const d=new C(tc); d.setOutputCallback(()=>{}); return d; };
let bad=0;
const cmp=(label,a,b)=>{
  const same=JSON.stringify(a)===JSON.stringify(b);
  if(!same) bad++;
  console.log('  '+label.padEnd(26)+(same?'match':'*** DIFFER'));
  if(!same){ console.log('      old sockets: '+JSON.stringify(a)); console.log('      via C      : '+JSON.stringify(b)); }
  else console.log('      '+JSON.stringify(a).slice(0,110));
};

(async()=>{
  console.log('  the old socket TypeScript vs the C, against a real devkit at '+IP);
  console.log('');
  const o=mk(OldDm), n=mk(NewDm);

  const oc=await o.connect(IP), nc=await n.connect(IP);
  cmp('connect().connected', oc.connected, nc.connected);
  cmp('connect().type', oc.type, nc.type);
  cmp('isConnected()', o.isConnected(), n.isConnected());
  cmp('listVolumes()', await o.listVolumes(IP), await n.listVolumes(IP));
  cmp('getSystemInfo()', await o.getSystemInfo(IP), await n.getSystemInfo(IP));
  for (const p of ['hdd:\\','DEVKIT:\\']) {
    const a=await o.listFiles(p,IP).catch(e=>'ERR: '+e.message);
    const b=await n.listFiles(p,IP).catch(e=>'ERR: '+e.message);
    cmp('listFiles("'+p+'")', a, b);
  }
  console.log('');
  console.log(bad===0 ? '  IDENTICAL AGAINST REAL HARDWARE' : '  *** '+bad+' DIFFERENCE(S) ON REAL HARDWARE');
  fs.unlinkSync(tmp);
  process.exit(bad?1:0);
})();
