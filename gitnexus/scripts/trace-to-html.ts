#!/usr/bin/env npx tsx
/**
 * Convert a trace JSON into an interactive collapsible tree HTML.
 *
 * - Nodes = services (repos, deduplicated)
 * - Edges = aggregated method calls between services
 * - Top-down (UD) D3.js collapsible tree
 * - True cycles vs shared refs distinguished
 *
 * Usage:
 *   npx tsx scripts/trace-to-html.ts <trace.json> [output.html]
 */

import fs from 'node:fs';
import path from 'node:path';

// Types
interface TraceCrossHop {
  contractId: string;
  contractType: string;
  matchType: string;
  linkConfidence: number;
  from: { repo: string; symbolUid: string; symbolName: string };
  to: { repo: string; symbolUid: string; symbolName: string };
}
interface TraceRepoSegment {
  repo: string;
  repoPath: string;
  entrySymbolUid: string;
  nodes: { id: string; name: string; type: string; filePath: string; depth: number }[];
  crossHops: TraceCrossHop[];
}
interface TraceResult {
  group: string;
  entryRepo: string;
  entryTarget: string;
  direction: string;
  segments: TraceRepoSegment[];
  skippedRepos: string[];
  truncated: boolean;
}

const inputFile = process.argv[2];
const outputFile = process.argv[3] || inputFile?.replace(/\.json$/, '.html') || 'trace.html';
if (!inputFile) { console.error('Usage: npx tsx scripts/trace-to-html.ts <trace.json> [output.html]'); process.exit(1); }

const trace: TraceResult = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));

// Step 1: Build service graph
interface ServiceInfo { repoPath: string; totalMethods: number; segmentCount: number; }
const serviceMap = new Map<string, ServiceInfo>();
for (const seg of trace.segments) {
  const e = serviceMap.get(seg.repoPath);
  if (e) { e.totalMethods += seg.nodes.length; e.segmentCount += 1; }
  else serviceMap.set(seg.repoPath, { repoPath: seg.repoPath, totalMethods: seg.nodes.length, segmentCount: 1 });
}

interface EdgeMethod { contractType: string; contractId: string; methodName: string; }
interface AggregatedEdge { from: string; to: string; methods: EdgeMethod[]; contractTypes: Set<string>; }
const edgeMap = new Map<string, AggregatedEdge>();

for (const seg of trace.segments) {
  for (const hop of seg.crossHops) {
    const isTopic = hop.contractType === 'topic';
    const fromRepo = seg.repoPath;
    const toRepo = isTopic
      ? (trace.direction === 'downstream' ? hop.from.repo : hop.to.repo)
      : (trace.direction === 'downstream' ? hop.to.repo : hop.from.repo);
    const rawContract = hop.contractId.replace(/^(thrift|topic|http|custom|grpc)::/, '');
    const methodName = rawContract.includes('/') ? rawContract.split('/').pop()! : rawContract;
    const key = fromRepo + '->' + toRepo;
    const existing = edgeMap.get(key);
    if (existing) {
      if (!existing.methods.some(m => m.contractId === hop.contractId)) {
        existing.methods.push({ contractType: hop.contractType, contractId: hop.contractId, methodName });
      }
      existing.contractTypes.add(hop.contractType);
    } else {
      edgeMap.set(key, { from: fromRepo, to: toRepo, methods: [{ contractType: hop.contractType, contractId: hop.contractId, methodName }], contractTypes: new Set([hop.contractType]) });
    }
  }
}

// Step 2: Build tree with cycle/ref distinction
interface TreeNodeData {
  name: string; domain: string; methods: number; children: TreeNodeData[];
  edgeMethods?: { type: string; name: string }[];
  edgeType?: string; edgeCount?: number;
  refType?: 'cycle' | 'ref';
  childCount?: number;
}

const entryRepo = trace.segments[0]?.repoPath ?? trace.entryRepo;
const globalVisited = new Set<string>();

function buildTree(repo: string, ancestors: Set<string>): TreeNodeData {
  const svc = serviceMap.get(repo);
  const node: TreeNodeData = { name: repo, domain: repo.split('/')[0], methods: svc?.totalMethods ?? 0, children: [] };
  globalVisited.add(repo);

  const outEdges: AggregatedEdge[] = [];
  for (const [, edge] of edgeMap) { if (edge.from === repo) outEdges.push(edge); }
  outEdges.sort((a, b) => b.methods.length - a.methods.length);

  const newAncestors = new Set(ancestors);
  newAncestors.add(repo);

  for (const edge of outEdges) {
    const typeCounts = new Map<string, number>();
    for (const m of edge.methods) typeCounts.set(m.contractType, (typeCounts.get(m.contractType) ?? 0) + 1);
    const primaryType = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const edgeInfo = { edgeMethods: edge.methods.map(m => ({ type: m.contractType, name: m.methodName })), edgeType: primaryType, edgeCount: edge.methods.length };

    if (ancestors.has(edge.to)) {
      node.children.push({ name: edge.to, domain: edge.to.split('/')[0], methods: 0, children: [], ...edgeInfo, refType: 'cycle' });
    } else if (globalVisited.has(edge.to)) {
      node.children.push({ name: edge.to, domain: edge.to.split('/')[0], methods: serviceMap.get(edge.to)?.totalMethods ?? 0, children: [], ...edgeInfo, refType: 'ref' });
    } else {
      const child = buildTree(edge.to, newAncestors);
      Object.assign(child, edgeInfo);
      node.children.push(child);
    }
  }
  return node;
}

const treeData = buildTree(entryRepo, new Set());

function calcChildCount(n: TreeNodeData): number {
  if (n.refType) return 0;
  let c = n.children.filter(x => !x.refType).length;
  for (const ch of n.children) if (!ch.refType) c += calcChildCount(ch);
  n.childCount = c;
  return c;
}
calcChildCount(treeData);

const totalEdgeMethods = [...edgeMap.values()].reduce((s, e) => s + e.methods.length, 0);
const maxDepthCalc = (n: TreeNodeData, d: number): number => {
  const rc = n.children.filter(c => !c.refType);
  return rc.length === 0 ? d : Math.max(...rc.map(c => maxDepthCalc(c, d + 1)));
};
const maxDepth = maxDepthCalc(treeData, 0);

// Step 3: Generate HTML
const treeDataJson = JSON.stringify(treeData);

const htmlContent = [
'<!DOCTYPE html>',
'<html lang="zh"><head><meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1.0">',
'<title>' + trace.entryTarget + ' Call Tree</title>',
'<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">',
'<script src="https://d3js.org/d3.v7.min.js"></script>',
'<style>',
':root{--bg:#0a0e1a;--card:rgba(15,23,42,0.9);--border:rgba(51,65,85,0.5);--text:#e2e8f0;--dim:#94a3b8;--muted:#64748b}',
'*{margin:0;padding:0;box-sizing:border-box}',
'body{font-family:"Inter",-apple-system,sans-serif;background:var(--bg);color:var(--text);overflow:hidden;height:100vh}',
'#header{position:fixed;top:0;left:0;right:0;z-index:100;padding:10px 24px;background:var(--card);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}',
'#header h1{font-size:14px;font-weight:600}',
'#header .badge{padding:2px 8px;border-radius:100px;font-size:10px;font-weight:500;background:rgba(59,130,246,0.12);color:#93c5fd;border:1px solid rgba(59,130,246,0.2);margin-left:10px}',
'#header .stats{display:flex;gap:14px;font-size:11px;color:var(--muted)}',
'#header .stats b{color:var(--dim);font-weight:600}',
'svg{width:100%;height:100vh}',
'.node-group{cursor:pointer}',
'.node-rect{stroke-width:1.5;transition:all 0.15s}',
'.node-group:hover .node-rect{stroke-width:2.5;filter:drop-shadow(0 0 8px rgba(255,255,255,0.08))}',
'.node-label{font-family:"Inter",sans-serif;font-size:10.5px;font-weight:500;fill:var(--text);pointer-events:none;text-anchor:middle}',
'.node-sub{font-family:"JetBrains Mono",monospace;font-size:8px;fill:var(--muted);pointer-events:none;text-anchor:middle}',
'.link{fill:none;stroke-width:1.3;transition:opacity 0.15s}',
'.link-label{font-family:"JetBrains Mono",monospace;font-size:8px;fill:var(--muted);pointer-events:none;text-anchor:middle}',
'#tooltip{display:none;position:fixed;background:var(--card);backdrop-filter:blur(16px);border:1px solid var(--border);border-radius:10px;padding:12px 16px;font-size:11px;z-index:200;max-height:50vh;overflow-y:auto;min-width:220px;max-width:360px;box-shadow:0 12px 40px rgba(0,0,0,0.5)}',
'#tooltip h4{font-size:12px;color:var(--text);margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border)}',
'#tooltip .tg{margin:6px 0}',
'#tooltip .tt{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px}',
'#tooltip .tt.thrift{color:#60a5fa}.tt.topic{color:#4ade80}.tt.http{color:#fb923c}.tt.custom{color:#fbbf24}',
'#tooltip .tm{font-family:"JetBrains Mono",monospace;font-size:10px;color:var(--dim);padding:2px 0 2px 10px;border-left:2px solid var(--border);margin:2px 0}',
'#ctrls{position:fixed;top:52px;left:16px;z-index:100;background:var(--card);backdrop-filter:blur(12px);border:1px solid var(--border);border-radius:10px;padding:8px 10px}',
'#ctrls button{display:block;width:100%;margin:3px 0;padding:5px 10px;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.15);border-radius:6px;color:#93c5fd;font-size:10px;cursor:pointer;transition:all 0.15s}',
'#ctrls button:hover{background:rgba(59,130,246,0.2)}',
'#legend{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);z-index:100;display:flex;gap:12px;align-items:center;background:var(--card);backdrop-filter:blur(12px);border:1px solid var(--border);border-radius:8px;padding:7px 16px;font-size:10px;color:var(--muted)}',
'.li{display:flex;align-items:center;gap:4px}',
'.ll{width:14px;height:2px;border-radius:1px}',
'.ld{width:14px;border-top:2px dashed;height:0}',
'</style></head><body>',
'<div id="header"><div style="display:flex;align-items:center"><h1>' + trace.entryTarget + '</h1><span class="badge">' + trace.direction + '</span></div>',
'<div class="stats"><span><b>' + serviceMap.size + '</b> services</span><span><b>' + totalEdgeMethods + '</b> methods</span><span><b>' + maxDepth + '</b> depth</span></div></div>',
'<div id="ctrls"><button onclick="col(1)">L1</button><button onclick="col(2)">L2</button><button onclick="col(3)">L3</button><button onclick="col(4)">L4</button><button onclick="col(5)">L5</button><button onclick="col(6)">L6</button><button onclick="col(7)">L7</button><button onclick="col(8)">L8</button><button onclick="col(9)">L9</button><button onclick="col(10)">L10</button><button onclick="expandAll()">Expand All</button><button onclick="fit()">Fit</button></div>',
'<div id="tooltip"></div>',
'<svg id="canvas"></svg>',
'<div id="legend">',
'<div class="li"><div class="ll" style="background:#60a5fa"></div>Thrift</div>',
'<div class="li"><div class="ll" style="background:#4ade80"></div>Topic</div>',
'<div class="li"><div class="ll" style="background:#fb923c"></div>HTTP</div>',
'<div class="li"><div class="ll" style="background:#fbbf24"></div>Custom</div>',
'<div class="li"><div class="ld" style="border-color:#f87171"></div>Cycle</div>',
'<div class="li"><div class="ld" style="border-color:#64748b"></div>Ref</div>',
'<span style="color:#475569;margin-left:6px">Click = expand/collapse | Hover = methods</span>',
'</div>',
'<script>',
'var TD=' + treeDataJson + ';',
'var TC={thrift:"#60a5fa",topic:"#4ade80",http:"#fb923c",grpc:"#a78bfa",custom:"#fbbf24"};',
'var DC={api:"#3b82f6",booking:"#f87171",order:"#fbbf24",basis:"#9ca3af",quote:"#a78bfa",flagship:"#f472b6",aftersale:"#2dd4bf",trade:"#fb923c",merchant:"#84cc16",biz:"#22d3ee",business:"#c084fc",eng:"#94a3b8",transfer:"#38bdf8",frontend:"#34d399"};',
'function gc(d){return DC[d]||"#64748b"}',
'var W=window.innerWidth,H=window.innerHeight;',
'var svg=d3.select("#canvas").attr("width",W).attr("height",H);',
'var g=svg.append("g");',
'var zm=d3.zoom().scaleExtent([0.1,5]).on("zoom",function(e){g.attr("transform",e.transform)});',
'svg.call(zm);',
'var root=d3.hierarchy(TD,function(d){return d.children});',
'root.x0=W/2;root.y0=60;',
'var nW=120,nH=28,dur=350;',
'function colN(d,mx,cur){if(d.children){if(cur>=mx){d._children=d.children;d.children=null}else d.children.forEach(function(c){colN(c,mx,cur+1)})}else if(d._children&&cur<mx){d.children=d._children;d._children=null;d.children.forEach(function(c){colN(c,mx,cur+1)})}}',
'root.children&&root.children.forEach(function(c){colN(c,2,1)});',
'var uid=0;',
'function update(src){',
'  var tree=d3.tree().nodeSize([nW+8,nH+70]).separation(function(a,b){return a.parent===b.parent?1:1.05});',
'  tree(root);',
'  var nodes=root.descendants(),links=root.links();',
'  var t=svg.transition().duration(dur);',
'  // Links',
'  var lk=g.selectAll("path.link").data(links,function(d){return d.target._uid||(d.target._uid=++uid)});',
'  var lkE=lk.enter().append("path").attr("class","link")',
'    .attr("d",function(){return lp({x:src.x0,y:src.y0},{x:src.x0,y:src.y0})})',
'    .attr("stroke",function(d){var r=d.target.data.refType;return r==="cycle"?"#f87171":r==="ref"?"#64748b":(TC[d.target.data.edgeType]||"#475569")})',
'    .attr("stroke-dasharray",function(d){return d.target.data.refType?"5,3":"none"})',
'    .attr("opacity",function(d){return d.target.data.refType?0.4:0.55});',
'  lk.merge(lkE).transition(t).attr("d",function(d){return lp(d.source,d.target)});',
'  lk.exit().transition(t).attr("d",function(){return lp({x:src.x,y:src.y},{x:src.x,y:src.y})}).remove();',
'  // Link labels',
'  var ll=g.selectAll("text.link-label").data(links,function(d){return"l"+(d.target._uid||(d.target._uid=++uid))});',
'  var llE=ll.enter().append("text").attr("class","link-label")',
'    .attr("x",src.x0).attr("y",src.y0)',
'    .text(function(d){var c=d.target.data.edgeCount||0;if(c<=1){var m=d.target.data.edgeMethods;return m&&m.length===1?(m[0].name.length>18?m[0].name.slice(0,16)+"..":m[0].name):""}return c+" calls"});',
'  ll.merge(llE).transition(t).attr("x",function(d){return(d.source.x+d.target.x)/2}).attr("y",function(d){return(d.source.y+d.target.y)/2});',
'  ll.exit().remove();',
'  // Nodes',
'  var nd=g.selectAll("g.node-group").data(nodes,function(d){return d._uid||(d._uid=++uid)});',
'  var ndE=nd.enter().append("g").attr("class","node-group")',
'    .attr("transform","translate("+src.x0+","+src.y0+")")',
'    .on("click",function(ev,d){if(d.data.refType)return;if(d.children){d._children=d.children;d.children=null}else if(d._children){d.children=d._children;d._children=null}update(d)})',
'    .on("mouseenter",function(ev,d){if(d.data.edgeMethods&&d.data.edgeMethods.length>1)showTip(ev,d)})',
'    .on("mouseleave",hideTip);',
'  ndE.append("rect").attr("class","node-rect")',
'    .attr("width",nW).attr("height",nH).attr("x",-nW/2).attr("y",-nH/2).attr("rx",6).attr("ry",6)',
'    .attr("fill",function(d){if(d.depth===0)return"#92400e";if(d.data.refType==="cycle")return"rgba(248,113,113,0.08)";if(d.data.refType==="ref")return"rgba(148,163,184,0.05)";return gc(d.data.domain)+"10"})',
'    .attr("stroke",function(d){if(d.depth===0)return"#fbbf24";if(d.data.refType==="cycle")return"#f87171";if(d.data.refType==="ref")return"#64748b";return gc(d.data.domain)})',
'    .attr("stroke-dasharray",function(d){return d.data.refType?"3,2":"none"});',
'  ndE.append("text").attr("class","node-label").attr("dy",-1)',
'    .text(function(d){var n=d.data.name,p=d.data.refType==="cycle"?"\\u21ba ":d.data.refType==="ref"?"\\u2192 ":"";return p+(n.length>16?n.slice(0,15)+"..":n)});',
'  ndE.append("text").attr("class","node-sub").attr("dy",11);',
'  var ndU=ndE.merge(nd);',
'  ndU.transition(t).attr("transform",function(d){return"translate("+d.x+","+d.y+")"});',
'  ndU.select(".node-sub").text(function(d){if(d.data.refType==="cycle")return"cycle";if(d.data.refType==="ref")return"ref";if(d._children)return"+"+d._children.length;if(d.children&&d.children.length)return d.children.length+" deps";return""});',
'  nd.exit().transition(t).attr("opacity",0).remove();',
'  nodes.forEach(function(d){d.x0=d.x;d.y0=d.y});',
'}',
'function lp(s,t){var my=(s.y+t.y)/2;return"M"+s.x+","+(s.y+nH/2)+" C"+s.x+","+my+" "+t.x+","+my+" "+t.x+","+(t.y-nH/2)}',
'function showTip(ev,d){',
'  var tip=document.getElementById("tooltip"),ms=d.data.edgeMethods||[];',
'  if(!ms.length){tip.style.display="none";return}',
'  var bt={};ms.forEach(function(m){(bt[m.type]=bt[m.type]||[]).push(m.name)});',
'  var h="<h4>"+(d.parent?d.parent.data.name:"")+" \\u2192 "+d.data.name+" ("+ms.length+")</h4>";',
'  for(var tp in bt){h+="<div class=\\"tg\\"><div class=\\"tt "+tp+"\\">"+tp+" ("+bt[tp].length+")</div>";bt[tp].slice(0,30).forEach(function(m){h+="<div class=\\"tm\\">"+m+"</div>"});if(bt[tp].length>30)h+="<div class=\\"tm\\" style=\\"color:#64748b\\">... +"+(bt[tp].length-30)+" more</div>";h+="</div>"}',
'  tip.innerHTML=h;tip.style.display="block";',
'  tip.style.left=(ev.pageX+14)+"px";tip.style.top=(ev.pageY-10)+"px";',
'  var r=tip.getBoundingClientRect();',
'  if(r.right>window.innerWidth)tip.style.left=(ev.pageX-r.width-10)+"px";',
'  if(r.bottom>window.innerHeight)tip.style.top=(window.innerHeight-r.height-10)+"px";',
'}',
'function hideTip(){document.getElementById("tooltip").style.display="none"}',
'function expandAll(){(function ex(d){if(d._children){d.children=d._children;d._children=null}if(d.children)d.children.forEach(ex)})(root);update(root);setTimeout(fit,500)}',
'function col(l){colN(root,l,0);update(root);setTimeout(fit,500)}',
'function fit(){',
'  var ns=root.descendants();if(!ns.length)return;',
'  var xs=ns.map(function(d){return d.x}),ys=ns.map(function(d){return d.y});',
'  var p=60,x0=Math.min.apply(null,xs)-p,x1=Math.max.apply(null,xs)+p,y0=Math.min.apply(null,ys)-p,y1=Math.max.apply(null,ys)+p;',
'  var bw=x1-x0,bh=y1-y0;',
'  var sc=Math.min((W-40)/bw,(H-80)/bh,2);',
'  var tx=W/2-(x0+bw/2)*sc,ty=50-(y0)*sc;',
'  svg.transition().duration(600).call(zm.transform,d3.zoomIdentity.translate(tx,ty).scale(sc));',
'}',
'update(root);setTimeout(fit,150);',
'</script></body></html>',
].join('\n');

fs.writeFileSync(outputFile, htmlContent, 'utf-8');
console.log('\u2705 Generated: ' + path.resolve(outputFile));
console.log('   Services: ' + serviceMap.size + ', Max depth: ' + maxDepth);
console.log('   Total edge methods: ' + totalEdgeMethods);
