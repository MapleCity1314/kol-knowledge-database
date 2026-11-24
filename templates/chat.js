/* ---------- AI 阅读助手 ----------
 * 检索在浏览器里完成：对本页内嵌的原推 / 思维模型 / 长文 / 附录做 BM25（中文按二字切分），
 * 取前 8 条片段发给网关；网关只负责拼提示词和转发免费模型，Key 不在页面里。
 * 回答里的 [n] 对应片段编号，点击跳到本页的原推、模型或长文。
 */
(() => {
  const ENDPOINT = META.chat;
  if (!ENDPOINT) return;

  const TOP_K = 8, EXCERPT = 600;
  const STOP = new Set(('什么 怎么 如何 为什 么样 他的 她的 他们 看法 观点 认为 一下 这个 那个 哪些 有没 没有 是否 一些 关于 对于 '
    + '他对 应该 可以 是不 不是 的话 怎样 有什 么看 么做 么判 他是 他在 他会 会不 有哪 哪个 吗他 如果 时候 '
    + 'the and for what how does his her about with that this are you').split(' '));
  const kindLabel = { tweet: '原推', model: '思维模型', article: '长文', appendix: '附录' };

  function tokens(s) {
    s = String(s || '').toLowerCase();
    const out = [];
    for (const m of s.matchAll(/\$?[a-z][a-z0-9]{1,15}|\d+(?:\.\d+)?/g)) out.push(m[0].replace(/^\$/, ''));
    for (const run of s.match(/[㐀-鿿]+/g) || []) {
      if (run.length === 1) out.push(run);
      else for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    }
    return out;
  }
  const selfTerms = new Set(tokens(`${META.name} ${META.handle}`));

  /* 索引在第一次提问时才建立 */
  let IDX;
  function buildIndex() {
    const docs = [];
    for (const t of DATA.tweets) docs.push({
      kind: 'tweet', id: t.id, label: `${day(t.date)} · ${t.topicCode || ''} ${t.topicTitle || ''}`.trim(),
      text: [t.text, t.shortNote && `（编者注：${t.shortNote}）`].filter(Boolean).join('\n'),
      boost: { S: 1.5, A: 1.3, B: 1, C: .85 }[t.qualityTier] || 1,
    });
    DATA.models.forEach((m, i) => docs.push({
      kind: 'model', idx: i, label: m.title,
      text: [m.quote && `原话：${m.quote}`, m.summary, ...(m.rules || []).map(r => `· ${r}`)].filter(Boolean).join('\n'),
      boost: 1.6,
    }));
    // 长文切成约 500 字的段落块分别建索引，否则整篇长文在 BM25 里会被长度惩罚压到最后
    for (const a of DATA.articles) {
      const label = `${a.title}${a.date ? ' · ' + day(a.date) : ''}`;
      const hl = highlights(a.highlights).join('\n');
      if (hl) docs.push({ kind: 'article', id: String(a.id), label, text: hl, boost: 1.2 });
      const paras = String(a.markdown || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
      let buf = '';
      const flush = () => { if (buf.trim()) docs.push({ kind: 'article', id: String(a.id), label, text: buf.trim(), boost: 1.1 }); buf = ''; };
      for (const para of paras) { if (buf && buf.length + para.length > 520) flush(); buf += para + '\n'; }
      flush();
    }
    for (const sec of DATA.appendix || []) for (const it of sec.items) docs.push({
      kind: 'appendix', id: String(it.id), sec: sec.id, group: it.group || '', label: `${sec.short} · ${day(it.date)}`,
      text: it.text, boost: .9,
    });
    const df = new Map(); let total = 0;
    for (const d of docs) {
      const tf = new Map();
      for (const w of tokens(d.label + '\n' + d.text)) tf.set(w, (tf.get(w) || 0) + 1);
      d.tf = tf; d.len = [...tf.values()].reduce((s, n) => s + n, 0) || 1; total += d.len;
      for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
    }
    return { docs, df, avg: total / docs.length };
  }

  function retrieve(query) {
    IDX ||= buildIndex();
    const { docs, df, avg } = IDX, N = docs.length;
    const q = [...new Set(tokens(query))].filter(w => !STOP.has(w) && !selfTerms.has(w));
    if (!q.length) return [];
    const idf = new Map(q.map(w => [w, Math.log(1 + (N - (df.get(w) || 0) + .5) / ((df.get(w) || 0) + .5))]));
    const scored = [];
    for (const d of docs) {
      let s = 0, matched = 0;
      for (const w of q) {
        const f = d.tf.get(w); if (!f) continue;
        matched++;
        s += idf.get(w) * (f * 2.2) / (f + 1.2 * (.25 + .75 * d.len / avg));
      }
      if (s > 0) scored.push({ d, s: s * d.boost * (.6 + .4 * matched / q.length) });
    }
    scored.sort((a, b) => b.s - a.s);
    const seen = new Set(), perDoc = new Map(), out = [];
    for (const { d } of scored) {
      const key = d.text.slice(0, 40);
      const owner = d.kind + ':' + (d.id ?? d.idx);
      if (seen.has(key) || (perDoc.get(owner) || 0) >= 2) continue; // 同一篇长文最多取 2 块
      seen.add(key); perDoc.set(owner, (perDoc.get(owner) || 0) + 1); out.push({ d, q });
      if (out.length >= TOP_K) break;
    }
    return out;
  }

  // 长文本只截取和问题最相关的段落
  function excerpt(text, q) {
    if (text.length <= EXCERPT) return text;
    const paras = text.split(/\n+/).filter(p => p.trim());
    const score = p => q.reduce((s, w) => s + (p.toLowerCase().includes(w) ? 1 : 0), 0);
    const ranked = paras.map((p, i) => ({ p, i, s: score(p) })).sort((a, b) => b.s - a.s || a.i - b.i);
    const keep = []; let len = 0;
    for (const r of ranked) { if (len + r.p.length > EXCERPT && keep.length) break; keep.push(r); len += r.p.length; }
    return keep.sort((a, b) => a.i - b.i).map(r => r.p).join('\n').slice(0, EXCERPT);
  }

  /* ---------- 界面 ---------- */
  const name = META.name;
  const tag = m => (m.tag || m.title || '').replace(/[（(].*$/, '').slice(0, 14);
  const sugg = ['他最核心的交易原则是什么？', '他是怎么止损和控制仓位的？', DATA.models[0] && `「${tag(DATA.models[0])}」具体怎么用？`].filter(Boolean);

  document.body.insertAdjacentHTML('beforeend', `
    <button class="ask-fab" id="askFab" aria-label="问 AI">问 AI<span>Ask</span></button>
    <aside class="ask" id="ask" hidden aria-label="AI 阅读助手">
      <header class="ask-head">
        <div><div class="eyebrow">AI 阅读助手</div><h3>问问「${esc(name)}」的档案</h3></div>
        <button class="icon-btn" data-ask-close aria-label="关闭">×</button>
      </header>
      <div class="ask-log" id="askLog">
        <div class="ask-intro">
          <p>回答只依据本页归档的原推、思维模型和长文，并用 <b class="cite-demo">1</b> 这样的编号标出处，点编号可以跳到原文。</p>
          <p class="fine">由免费模型生成，可能出错；不构成投资建议。</p>
          <div class="ask-sugg">${sugg.map(s => `<button data-ask-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>
        </div>
      </div>
      <form class="ask-form" id="askForm">
        <textarea id="askInput" rows="2" maxlength="600" placeholder="比如：他怎么判断一个币该不该追？"></textarea>
        <button type="submit" id="askSend">发送</button>
      </form>
    </aside>`);

  const panel = $('#ask'), log = $('#askLog'), input = $('#askInput'), send = $('#askSend');
  const history = [];
  let busy = null;

  const open = () => { panel.hidden = false; document.body.classList.add('ask-open'); setTimeout(() => input.focus(), 30); };
  const close = () => { panel.hidden = true; document.body.classList.remove('ask-open'); };

  function md(text, sources) {
    let h = esc(text)
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/^#{1,4}\s*(.+)$/gm, '<b>$1</b>')
      .replace(/^\s*[-*·]\s+(.+)$/gm, '<li>$1</li>')
      .replace(/^\s*(\d+)[.、]\s+(.+)$/gm, '<li class="ol" data-n="$1">$2</li>')
      .replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, m => `<ul>${m.replace(/\n/g, '')}</ul>`)
      .replace(/\n{2,}/g, '<span class="pg"></span>').replace(/\n/g, '<br>');
    return h.replace(/\[(\d{1,2})\]/g, (m, n) => sources[n - 1] ? `<button class="cite" data-cite="${n}" title="${esc(sources[n - 1].d.label)}">${n}</button>` : '');
  }

  function sourcesHTML(sources) {
    if (!sources.length) return '';
    return `<details class="ask-src"><summary>参考了 ${sources.length} 条档案</summary><ol>${sources.map((s, i) =>
      `<li><button class="cite" data-cite="${i + 1}">${i + 1}</button><span class="k">${kindLabel[s.d.kind]}</span>${esc(s.d.label)}</li>`).join('')}</ol></details>`;
  }

  async function ask(question) {
    question = question.trim();
    if (!question || busy) return;
    log.querySelector('.ask-intro')?.classList.add('compact');
    let sources = retrieve(question);
    const lastQ = [...history].reverse().find(m => m.role === 'user');
    if (sources.length < 3 && lastQ) sources = retrieve(lastQ.content + ' ' + question);
    if (!sources.length && DATA.models.length) sources = DATA.models.map((m, i) => ({ d: IDX.docs.find(d => d.kind === 'model' && d.idx === i), q: [] }));
    sources = sources.slice(0, TOP_K);

    const turn = document.createElement('div');
    turn.className = 'ask-turn';
    turn.innerHTML = `<div class="ask-q">${esc(question)}</div><div class="ask-a"><span class="ask-wait">正在翻档案…</span></div>`;
    log.appendChild(turn);
    const out = turn.querySelector('.ask-a');
    turn._sources = sources;
    log.scrollTop = log.scrollHeight;

    const payload = {
      slug: META.slug, name, question,
      sources: sources.map((s, i) => ({ n: i + 1, label: `${kindLabel[s.d.kind]} · ${s.d.label}`, text: excerpt(s.d.text, s.q) })),
      history: history.slice(-6),
    };
    const ctl = new AbortController();
    busy = ctl; send.textContent = '停止'; input.value = '';
    let text = '', raf = 0;
    const paint = () => { raf = 0; out.innerHTML = md(text, sources) + '<span class="caret"></span>'; if (log.scrollHeight - log.scrollTop - log.clientHeight < 120) log.scrollTop = log.scrollHeight; };
    try {
      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctl.signal });
      if (!res.ok || !res.body) {
        let msg = `AI 服务出错（${res.status}）`;
        try { msg = (await res.json()).error || msg; } catch {}
        throw new Error(msg);
      }
      const reader = res.body.getReader(), dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        raf ||= requestAnimationFrame(paint);
      }
      if (!text.trim()) throw new Error('模型没有返回内容，请换个问法再试');
      out.innerHTML = md(text, sources) + sourcesHTML(sources);
      history.push({ role: 'user', content: question }, { role: 'assistant', content: text.slice(0, 1200) });
    } catch (e) {
      cancelAnimationFrame(raf);
      const stopped = e.name === 'AbortError';
      const msg = stopped ? '已停止' : (e instanceof TypeError ? 'AI 服务暂时连不上，请检查网络后重试' : e.message);
      out.innerHTML = (text ? md(text, sources) : '') + `<p class="ask-err">${esc(msg)}</p>` + (text ? sourcesHTML(sources) : '');
    } finally {
      busy = null; send.textContent = '发送';
      log.scrollTop = log.scrollHeight;
    }
  }

  function goTo(src) {
    const d = src.d;
    if (matchMedia('(max-width: 760px)').matches) close();
    let el;
    if (d.kind === 'tweet') { jumpToTweet(d.id); return; }
    clearSearch();
    if (d.kind === 'model') el = document.querySelectorAll('#models .model')[d.idx];
    if (d.kind === 'article') {
      if (!document.getElementById(d.id)) renderArticles(true);
      el = document.getElementById(d.id);
    }
    if (d.kind === 'appendix') {
      if (!document.getElementById('tw-' + d.id)) { state.open.add(d.sec + '::' + d.group); renderAppendix(); }
      el = document.getElementById('tw-' + d.id) || document.getElementById(d.sec);
    }
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }

  $('#askFab').addEventListener('click', open);
  panel.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    e.stopPropagation();
    if (b.hasAttribute('data-ask-close')) close();
    else if (b.dataset.askQ) ask(b.dataset.askQ);
    else if (b.dataset.cite) { const src = b.closest('.ask-turn')?._sources?.[b.dataset.cite - 1]; if (src) goTo(src); }
  });
  $('#askForm').addEventListener('submit', e => { e.preventDefault(); busy ? busy.abort() : ask(input.value); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); busy ? null : ask(input.value); }
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });
})();
