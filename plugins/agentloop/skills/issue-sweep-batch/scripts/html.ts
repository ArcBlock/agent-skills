/**
 * 把分类结果渲染成一份**自包含**的 HTML —— 双击就能开，无 CDN、无构建。
 *
 * 为什么是 HTML 不是 SVG：需要人能操作——切视图、点开详情、顺着关系走。
 * SVG 只能看，看不了就没法用它做判断。
 *
 * 三个视图对应三种真实问题：
 *
 *   全局    现在的存量落在哪些车道？哪些是 unproven？   —— 一眼看清分布
 *   按 epic 在飞的 epic 各占哪些文件？谁和谁撞？        —— 派工前的冲突面
 *   单条    这一条和谁同车道、属于哪个 epic、撞了谁？    —— 从一个点顺关系走
 *
 * 这份 HTML 刻意不引任何外部资源：它要能在断网的机器上、从 file:// 打开就工作。
 * 将来做成 web component 集成进 factory / work object 时，数据契约（下面的 Model）
 * 不变，只换渲染宿主。
 */

export interface HtmlItem {
  id: number;
  title: string;
  type: string;
  /** 本轮是否进了分类流程（受 --types / --mode 影响）。未选中的仍然展示，标灰。 */
  selected?: boolean;
  lanes: string[];
  files: string[];
  surfaceState: "measured" | "unproven" | "code-located";
  reasons: string[];
  epic: number | null;
  url: string;
}

export interface HtmlEpic {
  id: number;
  title: string;
  members: number[];
  files: string[];
  url: string;
}

export interface HtmlOverlap {
  item: number;
  epic: number;
  shared: string[];
}

export interface OverviewSeries {
  labels: string[];
  opened: number[];
  closed: number[];
  stock: number[];
}

export interface Overview {
  total: number;
  byType: Record<string, { open: number; closed: number }>;
  unknownTypes: string[];
  /** 四种粒度各一套序列 */
  series: Record<string, OverviewSeries>;
  windowNote: string;
}

export interface Typing {
  untyped: number;
  total: number;
  autoRatio: number;
  rulesDerived: number;
  rulesActive: number;
  rules: { id: string; kind: string; pattern: string; type: string; support: number }[];
  groups: {
    feature: string;
    hint: string | null;
    ids: number[];
    titles: string[];
    homogeneity: number;
  }[];
  singletons: number[];
}

export interface Health {
  status: "healthy" | "degraded" | "action-required";
  humanAttention: boolean;
  headline: string;
  explanations: string[];
  signals: { id: string; severity: string; title: string; evidence: string }[];
}

export interface Model {
  overview?: Overview;
  health?: Health;
  aging?: Record<string, number>;
  typing?: Typing;
  /** 每种类型自己的分类轴与聚簇判据 —— 点类型卡时展示 */
  axes?: Record<string, { axis: string | null; question: string }>;
  generatedAt: string;
  repo: string;
  source: string;
  types: string[];
  mode: string;
  capabilities: Record<string, boolean>;
  totals: { all: number; candidates: number; selected: number; skipped: number };
  items: HtmlItem[];
  epics: HtmlEpic[];
  overlaps: HtmlOverlap[];
}

const CSS = `
:root{--bg:#0f1115;--panel:#171a21;--line:#262b36;--fg:#e6e9ef;--dim:#8b93a7;
--ok:#3fb950;--warn:#d29922;--bad:#f85149;--accent:#58a6ff;--chip:#1f2430}
@media(prefers-color-scheme:light){:root{--bg:#f6f7f9;--panel:#fff;--line:#e2e5ea;
--fg:#1c2128;--dim:#656d76;--chip:#eef1f5}}
*{box-sizing:border-box}
body{margin:0;font:13px/1.55 ui-sans-serif,-apple-system,"SF Pro Text",system-ui,sans-serif;
background:var(--bg);color:var(--fg)}
header{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;
gap:16px;align-items:baseline;flex-wrap:wrap}
h1{font-size:15px;margin:0;font-weight:600}
.meta{color:var(--dim);font-size:12px}
.tabs{display:flex;gap:4px;padding:10px 18px 0}
.tab{padding:6px 14px;border:1px solid var(--line);border-bottom:none;
border-radius:7px 7px 0 0;cursor:pointer;background:var(--chip);color:var(--dim)}
.tab.on{background:var(--panel);color:var(--fg);font-weight:600}
main{display:grid;grid-template-columns:1fr 380px;gap:0;height:calc(100vh - 108px)}
#view{overflow:auto;padding:16px 18px;border-top:1px solid var(--line)}
#detail{overflow:auto;padding:16px;border-left:1px solid var(--line);
border-top:1px solid var(--line);background:var(--panel)}
.lane{margin-bottom:18px}
.lane h3{font-size:12px;margin:0 0 6px;color:var(--dim);font-weight:600;
letter-spacing:.02em;font-family:ui-monospace,SFMono-Regular,monospace}
.grid{display:flex;flex-wrap:wrap;gap:6px}
.card{border:1px solid var(--line);background:var(--panel);border-radius:8px;
padding:7px 10px;cursor:pointer;max-width:330px;transition:.12s}
.card:hover{border-color:var(--accent)}
.card.sel{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.card .n{font-family:ui-monospace,monospace;color:var(--accent);font-size:12px}
.card .t{display:block;color:var(--fg);font-size:12px;margin-top:2px;
overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:310px}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;
vertical-align:middle}
.s-measured{background:var(--ok)}.s-unproven{background:var(--warn)}
.s-code-located{background:var(--accent)}
.epic{border:1px solid var(--line);background:var(--panel);border-radius:9px;
padding:12px 14px;margin-bottom:12px}
.epic h3{margin:0 0 8px;font-size:13px}
.badge{display:inline-block;padding:1px 7px;border-radius:20px;font-size:11px;
background:var(--chip);color:var(--dim);margin-left:6px}
.badge.bad{background:#3d1d1d;color:var(--bad)}
.badge.warn{background:#3a2f14;color:var(--warn)}
.badge.ok{background:#12331c;color:var(--ok)}
table{border-collapse:collapse;width:100%;font-size:12px}
td,th{padding:5px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--dim);font-weight:600}
code{font-family:ui-monospace,monospace;font-size:11.5px;background:var(--chip);
padding:1px 5px;border-radius:4px;word-break:break-all}
a{color:var(--accent)}
.empty{color:var(--dim);padding:30px 0;text-align:center}
.legend{display:flex;gap:14px;font-size:11.5px;color:var(--dim);margin-bottom:14px;flex-wrap:wrap}
.note{border-left:3px solid var(--warn);padding:8px 12px;background:var(--chip);
border-radius:0 6px 6px 0;font-size:12px;margin-bottom:14px;color:var(--dim)}
.hom{font-size:10.5px;padding:1px 6px;border-radius:10px;display:inline-block;margin-top:3px}
.hom.ok{background:#12331c;color:#9fe0ae}
.hom.warn{background:#3a2f14;color:#f0d08a}
.hom.bad{background:#3d1d1d;color:#ffb4b0}
tr.mixedrow{background:rgba(248,81,73,.05)}
.warnx{color:var(--warn);font-size:11px;display:block;margin-top:4px;max-width:280px}
.verdict{border-radius:10px;padding:14px 18px;margin-bottom:16px;border:1px solid}
.verdict.ok{background:#12331c;border-color:#1f6b32;color:#c9f5d4}
.verdict.warn{background:#3a2f14;border-color:#8a6d1f;color:#f6e3b6}
.verdict.bad{background:#3d1d1d;border-color:#8b2c2c;color:#ffd0cd}
.vtop{font-size:17px;letter-spacing:.03em;display:flex;align-items:center;gap:10px}
.vatt{margin-left:auto;font-size:12px;opacity:.8;border:1px solid currentColor;
border-radius:20px;padding:2px 12px}
.vhead{margin-top:6px;font-size:13px;opacity:.95}
.vex{margin:8px 0 0;padding-left:20px;font-size:12px;opacity:.88}
.vex li{margin:3px 0}
.ages{display:flex;gap:18px;align-items:flex-end;padding:8px 4px 0}
.agecol{text-align:center}
.agebar{width:52px;background:var(--accent);border-radius:4px 4px 0 0}
.agebar.old{background:var(--warn)}
.agev{font-size:14px;font-weight:600;margin-top:4px}
.agek{font-size:11px;color:var(--dim)}
.sev{border-radius:9px;padding:12px 16px;margin-bottom:14px;font-size:13px;
border:1px solid var(--line)}
.sev.bad{background:#3d1d1d;border-color:#8b2c2c;color:#ffb4b0}
.sev.warn{background:#3a2f14;border-color:#8a6d1f;color:#f0d08a}
.sev.ok{background:#12331c;border-color:#1f6b32;color:#9fe0ae}
.sev .dim{opacity:.85;font-size:12px}
.cov{display:flex;align-items:center;gap:12px;font-size:12px}
.covbar{flex:0 0 220px;height:9px;background:var(--chip);border-radius:6px;overflow:hidden}
.covbar i{display:block;height:100%;background:var(--accent)}
table.dt td{vertical-align:top}
table.dt .ids{font-size:11.5px;color:var(--dim);max-width:520px}
table.dt .ids a{margin-right:4px}
select.pick{background:var(--chip);border:1px solid var(--line);color:var(--fg);
border-radius:6px;padding:4px 8px;font-size:12px}
.exp{margin-top:10px}
#gen{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:6px 14px;
font-size:12px;cursor:pointer}
.cmd{background:var(--chip);border-radius:6px;padding:10px;font-size:11.5px;
white-space:pre-wrap;max-height:260px;overflow:auto;margin-top:8px}
.tbar{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:12px}
.tchip{padding:4px 12px;border-radius:20px;background:var(--chip);color:var(--dim);
cursor:pointer;font-size:12px;border:1px solid transparent}
.tchip.on{background:var(--accent);color:#fff;font-weight:600}
.tchip:hover{border-color:var(--accent)}
.axis{border-left:3px solid var(--accent);padding:8px 12px;background:var(--chip);
border-radius:0 6px 6px 0;font-size:12px;margin-bottom:14px}
.axis .dim{color:var(--dim)}
.card.dim{opacity:.72}
.scopenote{border-left:3px solid var(--dim);padding:8px 12px;
background:var(--chip);border-radius:0 6px 6px 0;font-size:12px;margin-bottom:14px;color:var(--dim)}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}
.stat{border:1px solid var(--line);background:var(--panel);border-radius:9px;
padding:10px 16px;min-width:104px;cursor:pointer}
.stat.big{background:var(--chip);cursor:default}
.stat .k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.stat .v{font-size:26px;font-weight:600;line-height:1.2}
.stat .sub{color:var(--dim);font-size:11px}
.chartbox{border:1px solid var(--line);background:var(--panel);border-radius:9px;
padding:12px 14px;margin-bottom:14px}
.chead{display:flex;gap:12px;align-items:baseline;margin-bottom:8px;flex-wrap:wrap}
.chead .dim{color:var(--dim);font-size:11.5px}
.gtabs{margin-left:auto;display:flex;gap:4px}
.gtab{padding:3px 10px;border-radius:6px;background:var(--chip);color:var(--dim);
cursor:pointer;font-size:11.5px}
.gtab.on{background:var(--accent);color:#fff}
.chart{width:100%;height:auto;display:block}
.legend2{display:flex;gap:14px;font-size:11.5px;color:var(--dim);margin-top:4px;align-items:center}
.legend2 i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;
vertical-align:middle}
input[type=search]{background:var(--chip);border:1px solid var(--line);color:var(--fg);
border-radius:6px;padding:5px 10px;font-size:12px;width:220px}
`;

const JS = String.raw`
const M = window.__MODEL__;
let view = "overview", sel = null, q = "", gran = "day", ftype = null;
const byId = new Map(M.items.map(i => [i.id, i]));
const epicById = new Map(M.epics.map(e => [e.id, e]));
const ov = M.overlaps;
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

function card(i) {
  return '<div class="card' + (sel === i.id ? ' sel' : '') +
    (i.selected === false ? ' dim' : '') + '" data-id="' + i.id + '">' +
    '<span class="dot s-' + i.surfaceState + '"></span>' +
    '<span class="n">#' + i.id + '</span>' +
    '<span class="t">' + esc(i.title) + '</span></div>';
}
function match(i) {
  if (ftype && i.type !== ftype) return false;
  if (!q) return true;
  const s = q.toLowerCase();
  return String(i.id).includes(s) || i.title.toLowerCase().includes(s) ||
    i.lanes.some(l => l.toLowerCase().includes(s));
}

function typeBar() {
  const order = ['bug','feature','idea','research','report','untyped'];
  const counts = {};
  for (const i of M.items) counts[i.type] = (counts[i.type] || 0) + 1;
  const chip = (t, l) =>
    '<span class="tchip' + (ftype === t ? ' on' : '') + '" data-ftype="' + (t === null ? '' : t) + '">' +
    l + (t === null ? ' ' + M.items.length : ' ' + (counts[t] || 0)) + '</span>';
  let h = '<div class="tbar">' + chip(null, '全部') + order.map(t => chip(t, t)).join('') + '</div>';
  if (ftype) {
    const inScope = M.items.some(i => i.type === ftype && i.selected);
    if (!inScope) {
      h += '<div class="scopenote">本轮 <code>--types ' + esc(M.types.join(',')) +
        '</code> 没有扫 <b>' + esc(ftype) + '</b>，下面只是**存量展示**：' +
        '路径面已算，但没有进本轮分类流程（卡片略淡）。' +
        '要分类它：<code>--types ' + esc(ftype) + '</code> 重跑。</div>';
    }
  }
  if (ftype && M.axes && M.axes[ftype]) {
    const a = M.axes[ftype];
    h += '<div class="axis"><b>' + esc(ftype) + '</b> 的分类轴：<code>' +
      esc(a.axis || '无轴 —— 必须先定类型') + '</code>' +
      (a.question ? '<br><span class="dim">聚簇判据：' + esc(a.question) + '</span>' : '') + '</div>';
  }
  return h;
}

function renderTyping() {
  const t = M.typing;
  if (!t) return '<div class="empty">本轮未采集归类数据。</div>';
  const pct = t.total ? Math.round(t.untyped / t.total * 100) : 0;
  const sev = pct >= 25 ? 'bad' : pct >= 10 ? 'warn' : 'ok';
  let h = '<div class="sev ' + sev + '"><b>untyped ' + t.untyped + ' / ' + t.total +
    '（' + pct + '%）</b><br><span class="dim">分类决定后面的 routing / priority / verification / ' +
    'repair policy。对自主系统，「不知道自己 ' + pct + '% 的库存是什么」比对人类团队严重——' +
    '这与「FAILED 太粗」是同一类缺陷：<b>结果面的词汇不足以推出下一步</b>。</span></div>';

  h += '<div class="chartbox"><div class="chead"><b>自动归类覆盖率</b>' +
    '<span class="dim">学习有没有真发生，看这个数：人每做一次判断，它应当上升</span></div>' +
    '<div class="cov"><div class="covbar"><i style="width:' + Math.round(t.autoRatio*100) + '%"></i></div>' +
    '<span>' + Math.round(t.autoRatio*100) + '% —— 规则派生 ' + t.rulesDerived +
    ' 条，回放守卫保留 <b>' + t.rulesActive + '</b> 条（拒绝 ' + (t.rulesDerived - t.rulesActive) + '）</span></div></div>';

  if (t.groups.length) {
    h += '<div class="chartbox"><div class="chead"><b>批量判断单</b><span class="dim">' +
      t.groups.length + ' 次判断覆盖 ' + t.groups.reduce((a,g)=>a+g.ids.length,0) +
      ' 条；选好类型后点底部导出命令</span></div>';
    h += '<table class="dt"><tr><th>覆盖</th><th>共享特征</th><th>类型</th><th>条目</th></tr>';
    for (const [n, g] of t.groups.entries()) {
      const opts = ['', 'bug','feature','idea','research','report']
        .map(o => '<option value="' + o + '"' + (o === g.hint ? ' selected' : '') + '>' +
          (o || '— 请选 —') + '</option>').join('');
      const hom = Math.round((g.homogeneity ?? 0) * 100);
      const mixed = hom < 50;
      h += '<tr' + (mixed ? ' class="mixedrow"' : '') + '><td><b>+' + g.ids.length + '</b>' +
        '<br><span class="hom ' + (hom >= 80 ? 'ok' : hom >= 50 ? 'warn' : 'bad') + '">齐 ' + hom + '%</span></td>' +
        '<td><code>' + esc(g.feature) + '</code>' +
        (g.hint ? '<br><span class="dim">规则提示：' + g.hint + '</span>' : '') +
        (mixed ? '<br><span class="warnx">⚠ 组内标题前缀五花八门。<code>skill:</code> 是<b>出处</b>信号' +
          '不是类型信号——一次性给它们定同一类型很可能是错的，建议展开逐条看。</span>' : '') + '</td>' +
        '<td><select class="pick" data-g="' + n + '">' + opts + '</select></td>' +
        '<td class="ids">' + g.ids.map((id,k) =>
          '<div><a href="#" data-id="' + id + '">#' + id + '</a> ' +
          esc(g.titles[k] || '') + '</div>').join('') + '</td></tr>';
    }
    h += '</table><div class="exp"><button id="gen">生成 gh 命令</button>' +
      '<pre id="cmd" class="cmd"></pre></div></div>';
  }
  if (t.singletons.length) {
    h += '<div class="chartbox"><div class="chead"><b>只能逐条看</b>' +
      '<span class="dim">' + t.singletons.length + ' 条无共享特征 —— 不假装它们能批量</span></div>' +
      '<div class="grid">' + t.singletons.map(id =>
        '<div class="card" data-id="' + id + '"><span class="n">#' + id + '</span></div>').join('') + '</div></div>';
  }
  h += '<div class="note">选好类型 → 生成的 <code>gh</code> 命令给这些 issue 打 label。' +
    '下一轮跑本 skill 时，这些判断会被当作<b>人类判断</b>长成规则，' +
    '同形状的新 issue 自动归类，上面的覆盖率会上升。</div>';
  return h;
}

function renderGlobal() {
  const items = M.items.filter(match);
  const head = typeBar() + legend();
  if (!items.length) return head + '<div class="empty">没有匹配项</div>';
  const lanes = new Map();
  for (const i of items) {
    const ks = i.lanes.length ? i.lanes : ["（无路径 · unproven）"];
    for (const k of ks) lanes.set(k, [...(lanes.get(k) || []), i]);
  }
  const rows = [...lanes].sort((a, b) => b[1].length - a[1].length);
  return head + rows.map(([lane, is]) =>
    '<div class="lane"><h3>' + esc(lane) + ' <span class="badge">' + is.length + '</span></h3>' +
    '<div class="grid">' + is.map(card).join('') + '</div></div>').join('');
}

function renderEpics() {
  const withOv = new Map();
  for (const o of ov) withOv.set(o.epic, [...(withOv.get(o.epic) || []), o]);
  const es = M.epics.slice().sort((a, b) =>
    (withOv.get(b.id) || []).length - (withOv.get(a.id) || []).length || b.members.length - a.members.length);
  return legend() + es.map(e => {
    const os = withOv.get(e.id) || [];
    const st = e.files.length === 0
      ? '<span class="badge warn">落点未知 · unproven</span>'
      : os.length ? '<span class="badge bad">' + os.length + ' 处冲突</span>'
        : '<span class="badge ok">不相交</span>';
    return '<div class="epic"><h3><a href="' + e.url + '" target="_blank">#' + e.id + '</a> ' +
      esc(e.title) + st + '<span class="badge">' + e.members.length + ' 成员</span>' +
      '<span class="badge">' + e.files.length + ' 文件</span></h3>' +
      (os.length ? '<table><tr><th>候选</th><th>撞的文件</th></tr>' + os.map(o =>
        '<tr><td><a href="#" data-id="' + o.item + '">#' + o.item + '</a></td><td>' +
        o.shared.map(f => '<code>' + esc(f) + '</code>').join(' ') + '</td></tr>').join('') + '</table>' : '') +
      '</div>';
  }).join('');
}

function renderTrace() {
  if (!sel) return '<div class="empty">在「全局」里点一条，或用右上搜索框定位，再回到本视图。</div>';
  const i = byId.get(sel);
  if (!i) return '<div class="empty">该条不在本轮候选里。</div>';
  const sameLane = M.items.filter(x => x.id !== i.id && x.lanes.some(l => i.lanes.includes(l)));
  const shares = M.items.filter(x => x.id !== i.id && x.files.some(f => i.files.includes(f)));
  const os = ov.filter(o => o.item === i.id);
  let h = '<div class="epic"><h3>#' + i.id + ' ' + esc(i.title) + '</h3>' +
    '<table><tr><th>类型</th><td>' + esc(i.type) + '</td></tr>' +
    '<tr><th>路径面</th><td><span class="dot s-' + i.surfaceState + '"></span>' + i.surfaceState +
    (i.files.length ? '<br>' + i.files.map(f => '<code>' + esc(f) + '</code>').join('<br>') : '') + '</td></tr>' +
    '<tr><th>epic</th><td>' + (i.epic ? '#' + i.epic : '—') + '</td></tr></table></div>';
  h += section('与在飞 epic 的冲突', os.length
    ? os.map(o => '<div>epic <a href="#" data-epic="' + o.epic + '">#' + o.epic + '</a> · ' +
      o.shared.map(f => '<code>' + esc(f) + '</code>').join(' ') + '</div>').join('')
    : '<div class="empty">无</div>');
  h += section('共享文件的其他候选（同一次改动可能互撞）', shares.length
    ? '<div class="grid">' + shares.map(card).join('') + '</div>' : '<div class="empty">无</div>');
  h += section('同车道（' + i.lanes.join(', ') + '）', sameLane.length
    ? '<div class="grid">' + sameLane.map(card).join('') + '</div>' : '<div class="empty">无</div>');
  return h;
}
function healthBanner() {
  const h = M.health;
  if (!h) return '';
  const icon = h.status === 'healthy' ? '🟢' : h.status === 'degraded' ? '🟡' : '🔴';
  const label = h.status === 'healthy' ? 'HEALTHY'
    : h.status === 'degraded' ? 'DEGRADED' : 'ACTION REQUIRED';
  const cls = h.status === 'healthy' ? 'ok' : h.status === 'degraded' ? 'warn' : 'bad';
  return '<div class="verdict ' + cls + '">' +
    '<div class="vtop">' + icon + ' <b>' + label + '</b>' +
    '<span class="vatt">' + (h.humanAttention ? '需要人介入' : '不需要人介入') + '</span></div>' +
    '<div class="vhead">' + esc(h.headline) + '</div>' +
    (h.explanations.length
      ? '<ul class="vex">' + h.explanations.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>'
      : '') + '</div>';
}

function agingRow() {
  const a = M.aging;
  if (!a) return '';
  const order = ['<1d','1-3d','3-7d','7-14d','>14d'];
  const max = Math.max(1, ...order.map(k => a[k] || 0));
  return '<div class="chartbox"><div class="chead"><b>年龄分布</b>' +
    '<span class="dim">总量不重要，年龄重要：>7d 持续变厚 = 工厂开始遗忘工作</span></div>' +
    '<div class="ages">' + order.map(k => {
      const v = a[k] || 0, old = k === '7-14d' || k === '>14d';
      return '<div class="agecol"><div class="agebar' + (old ? ' old' : '') +
        '" style="height:' + Math.round(v / max * 70 + 4) + 'px"></div>' +
        '<div class="agev">' + v + '</div><div class="agek">' + k + '</div></div>';
    }).join('') + '</div></div>';
}

function renderOverview() {
  const o = M.overview;
  if (!o) return '<div class="empty">本轮未采集概览数据（加 --stats 重跑）。</div>';
  const order = ['bug','feature','idea','research','report','untyped'];
  const cards = ['<div class="stat big"><div class="k">全部 open</div><div class="v">' + o.total + '</div></div>']
    .concat(order.map(t => {
      const c = o.byType[t] || {open:0, closed:0};
      return '<div class="stat" data-type="' + t + '"><div class="k">' + t + '</div>' +
        '<div class="v">' + c.open + '</div>' +
        '<div class="sub">已关 ' + c.closed + '</div></div>';
    })).join('');
  const s2 = o.series[gran];
  const gtabs = [['hour','小时'],['day','天'],['week','周'],['month','30 天']]
    .map(([k,l]) => '<span class="gtab' + (gran===k?' on':'') + '" data-g="' + k + '">' + l + '</span>').join('');
  return healthBanner() + '<div class="stats">' + cards + '</div>' + agingRow() +
    (o.unknownTypes.length ? '<div class="note">未归入已知类型：' + o.unknownTypes.map(esc).join(', ') + '</div>' : '') +
    '<div class="chartbox"><div class="chead"><b>流量 · 开 vs 关</b>' +
    '<span class="dim">进货比出货快，存量就涨——这是「修了这么多为什么总数不降」的直接答案</span>' +
    '<span class="gtabs">' + gtabs + '</span></div>' + bars(s2) + '</div>' +
    '<div class="chartbox"><div class="chead"><b>存量 · 还开着的总数</b>' +
    '<span class="dim">流量的积分，滞后于流量：净值转负数天后这条线才明显下弯</span></div>' +
    line(s2) + '</div>' +
    '<div class="note">' + esc(o.windowNote) + '</div>';
}

function bars(s) {
  const max = Math.max(1, ...s.opened, ...s.closed);
  const W = 1000, H = 190, n = s.labels.length, bw = W / n;
  let g = '';
  for (let i = 0; i < n; i++) {
    const ho = (s.opened[i] / max) * (H - 46), hc = (s.closed[i] / max) * (H - 46);
    const x = i * bw, net = s.opened[i] - s.closed[i];
    g += '<rect x="' + (x + bw*0.12) + '" y="' + (H - 20 - ho) + '" width="' + bw*0.34 + '" height="' + ho + '" fill="#f85149" opacity=".85"><title>' + s.labels[i] + ' 开 ' + s.opened[i] + '</title></rect>';
    g += '<rect x="' + (x + bw*0.52) + '" y="' + (H - 20 - hc) + '" width="' + bw*0.34 + '" height="' + hc + '" fill="#3fb950" opacity=".85"><title>' + s.labels[i] + ' 关 ' + s.closed[i] + '</title></rect>';
    if (n <= 32) g += '<text x="' + (x + bw/2) + '" y="' + (H - 6) + '" font-size="9" text-anchor="middle" fill="currentColor" opacity=".5">' + s.labels[i] + '</text>';
    if (net !== 0 && n <= 32) g += '<text x="' + (x + bw/2) + '" y="12" font-size="9" text-anchor="middle" fill="' + (net>0?'#f85149':'#3fb950') + '">' + (net>0?'+':'') + net + '</text>';
  }
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart">' + g + '</svg>' +
    '<div class="legend2"><span><i style="background:#f85149"></i>开</span><span><i style="background:#3fb950"></i>关</span>' +
    '<span class="dim">柱顶数字 = 净值（红 = 存量在涨）</span></div>';
}

function line(s) {
  const max = Math.max(1, ...s.stock), min = Math.min(...s.stock);
  const W = 1000, H = 150, n = s.stock.length;
  const x = i => (i / Math.max(1, n - 1)) * (W - 20) + 10;
  const y = v => H - 22 - ((v - min) / Math.max(1, max - min)) * (H - 42);
  const pts = s.stock.map((v, i) => x(i) + ',' + y(v)).join(' ');
  let dots = '';
  for (let i = 0; i < n; i++)
    dots += '<circle cx="' + x(i) + '" cy="' + y(s.stock[i]) + '" r="2.5" fill="#58a6ff"><title>' + s.labels[i] + ' 存量 ' + s.stock[i] + '</title></circle>';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart">' +
    '<polyline points="' + pts + '" fill="none" stroke="#58a6ff" stroke-width="2"/>' + dots +
    '<text x="10" y="12" font-size="10" fill="currentColor" opacity=".5">最高 ' + max + '</text>' +
    '<text x="10" y="' + (H - 6) + '" font-size="10" fill="currentColor" opacity=".5">最低 ' + min + '</text></svg>';
}

function section(t, b) { return '<div class="epic"><h3>' + esc(t) + '</h3>' + b + '</div>'; }

function legend() {
  return '<div class="legend">' +
    '<span><span class="dot s-measured"></span>measured —— 落点已知，可判定不相交</span>' +
    '<span><span class="dot s-unproven"></span>unproven —— 正文无路径，<b>不等于</b>不相交</span>' +
    '<span><span class="dot s-code-located"></span>code-located —— 读代码补出的落点</span></div>' +
    (M.capabilities.neighborhood ? '' :
      '<div class="note">本源无邻域信号：只看得见工作项<b>自身</b>的变化。'
      + '「邻居合了导致旧分类不成立」这一类失效整类不可见。</div>');
}

function renderDetail() {
  const d = document.getElementById('detail');
  if (!sel) { d.innerHTML = '<div class="empty">点一张卡片看详情</div>'; return; }
  const i = byId.get(sel);
  if (!i) { d.innerHTML = '<div class="empty">—</div>'; return; }
  d.innerHTML = '<h3 style="margin:0 0 4px"><a href="' + i.url + '" target="_blank">#' + i.id + '</a></h3>' +
    '<div style="margin-bottom:12px">' + esc(i.title) + '</div>' +
    '<table><tr><th>类型</th><td>' + esc(i.type) + '</td></tr>' +
    '<tr><th>车道</th><td>' + (i.lanes.map(esc).join('<br>') || '—') + '</td></tr>' +
    '<tr><th>状态</th><td><span class="dot s-' + i.surfaceState + '"></span>' + i.surfaceState + '</td></tr>' +
    '<tr><th>落点</th><td>' + (i.files.length ? i.files.map(f => '<code>' + esc(f) + '</code>').join('<br>') : '<i>未知</i>') + '</td></tr>' +
    '<tr><th>需重分类的理由</th><td>' + (i.reasons.length ? i.reasons.map(esc).join('<br>') : '—') + '</td></tr></table>' +
    '<p style="margin-top:14px"><a href="#" data-trace="' + i.id + '">→ 从这一条看关联</a></p>';
}

function render() {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.v === view));
  document.getElementById('view').innerHTML =
    view === 'overview' ? renderOverview() :
    view === 'typing' ? renderTyping() :
    view === 'global' ? renderGlobal() : view === 'epics' ? renderEpics() : renderTrace();
  renderDetail();
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-id],[data-epic],[data-trace],[data-type],[data-ftype],.tab,.gtab');
  if (!t) return;
  if (t.classList.contains('gtab')) { gran = t.dataset.g; render(); return; }
  if (t.dataset.type) { ftype = t.dataset.type; view = 'global'; q = ''; render(); return; }
  if (t.dataset.ftype !== undefined) {
    e.preventDefault(); ftype = t.dataset.ftype || null; render(); return;
  }
  if (t.classList.contains('tab')) { view = t.dataset.v; render(); return; }
  if (t.dataset.trace) { e.preventDefault(); sel = +t.dataset.trace; view = 'trace'; render(); return; }
  if (t.dataset.epic) { e.preventDefault(); view = 'epics'; render(); return; }
  e.preventDefault(); sel = +t.dataset.id; render();
});
document.getElementById('q').addEventListener('input', e => { q = e.target.value; render(); });
document.addEventListener('click', e => {
  if (e.target.id !== 'gen') return;
  const lines = [];
  document.querySelectorAll('select.pick').forEach(sel => {
    const v = sel.value; if (!v) return;
    const g = M.typing.groups[+sel.dataset.g];
    lines.push('# ' + g.feature + '  (' + g.ids.length + ' 条)');
    for (const id of g.ids)
      lines.push('gh issue edit ' + id + ' -R ' + M.repo + ' --add-label ' + v);
  });
  document.getElementById('cmd').textContent = lines.length
    ? lines.join('\n') : '（还没选任何类型）';
});
render();
`;

export function renderHtml(m: Model): string {
  const caps = Object.entries(m.capabilities)
    .map(([k, v]) => `${k}=${v}`)
    .join(" · ");
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>issue-sweep-batch — ${m.repo}</title>
<style>${CSS}</style></head><body>
<header>
  <h1>issue-sweep-batch</h1>
  <span class="meta">${m.repo} · 源 ${m.source} · 类型 ${m.types.join(",")} · 模式 ${m.mode}</span>
  <span class="meta">存量 ${m.totals.all} · 候选 ${m.totals.candidates} · 选中 ${m.totals.selected} · 跳过 ${m.totals.skipped}</span>
  <span class="meta">能力 ${caps}</span>
  <span class="meta">${m.generatedAt}</span>
  <input id="q" type="search" placeholder="搜编号 / 标题 / 车道" style="margin-left:auto">
</header>
<div class="tabs">
  <div class="tab on" data-v="overview">概览</div>
  <div class="tab" data-v="global">全局</div>
  <div class="tab" data-v="typing">归类</div>
  <div class="tab" data-v="epics">按 epic</div>
  <div class="tab" data-v="trace">单条追溯</div>
</div>
<main><div id="view"></div><div id="detail"></div></main>
<script>window.__MODEL__=${JSON.stringify(m).replace(/</g, "\\u003c")};</script>
<script>${JS}</script>
</body></html>`;
}
