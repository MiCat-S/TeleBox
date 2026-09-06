const {loadSource} = require('./source-harness.cjs');
const {htmlEscape} = loadSource('src/utils/htmlEscape.ts');
const cases = [
  {name:'help', text:'.gt help', missing:true},
  {name:'paragraphs', text:'.gt Hello\n\nworld', output:'<你好>&"\''},
  {name:'reply-en', text:'.gt\tEN', reply:'你好\n世界', output:'Hello'},
  {name:'missing-text', text:'.gt'},
  {name:'long-input', text:'.gt '+ 'a'.repeat(5001)},
  {name:'utf16-limit', text:'.gt '+ '😀'.repeat(2501)},
  {name:'boundary', text:'.gt '+ '😀'.repeat(2500), output:'ok'},
  {name:'missing-provider', text:'.gt Hello', missing:true},
  {name:'split', text:'.gt Hello', output:'a'.repeat(2999)+'😀'+'b'.repeat(3500)},
  {name:'error', text:'.gt Hello', failure:true},
  {name:'empty-output', text:'.gt Hello', output:' \ufeff'},
  {name:'js-whitespace', text:'.gt\ufeffen\u00a0Hello', output:'yes'},
  {name:'not-js-whitespace', text:'.gt \u0085', output:'yes'},
  {name:'preview', text:'.gt '+ '😀'.repeat(51), output:'yes'},
];
(async () => {
  for (const c of cases) {
    c.edits = []; c.replies = []; c.requests = [];
    const ai = c.missing ? undefined : {async translateText(text, target) {
      c.requests.push([text, target]);
      if (c.failure) throw new Error('secret-api-key');
      return c.output ?? 'ok';
    }};
    const plugin = loadSource('../TeleBox-Plugins/gt/gt.ts', {
      '@utils/pluginBase': {Plugin: class {}},
      '@utils/pluginManager': {getPluginEntry: () => ai ? {plugin: ai} : undefined},
      '@utils/safeGetMessages': {safeGetReplyMessage: async () => ({text:c.reply || ''})},
      '@utils/htmlEscape': {htmlEscape},
    }, {AbortController}).default;
    await plugin.cmdHandlers.gt({message:c.text,
      edit: async o => c.edits.push(o.text), reply: async o => c.replies.push(o.message)});
    plugin.cleanup();
  }
  process.stdout.write(JSON.stringify(cases));
})().catch(e => { console.error(e); process.exitCode = 1; });
