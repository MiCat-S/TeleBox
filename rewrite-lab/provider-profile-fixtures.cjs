const {loadBindings} = require('./source-harness.cjs');
const {resolveProviderType} = loadBindings('../TeleBox-Plugins/ai/ai.ts', [
  'PROVIDER_TYPES', 'DEFAULT_PROVIDER_TYPE', 'mapHostsToProviderType',
  'PROVIDER_HOST_TYPES', 'getProviderHost', 'isProviderType',
  'normalizeProviderType', 'resolveProviderType',
], {URL});
const cases = [
  {url:'https://api.openai.com/v1'},
  {url:'https://generativelanguage.googleapis.com'},
  {url:'https://ark.cn-beijing.volces.com/api/v3'},
  {url:'https://api.moonshot.cn/v1'},
  {url:'http://127.0.0.1:8317/v1'},
  {url:'https://api.abjj.de/v1'},
  {url:'https://custom.example.invalid/v1'},
  {url:'http://localhost:8317/v1'},
  {url:'http://[::1]:8317/v1'},
  {url:'https://API.MOONSHOT.CN:443/v1'},
  {url:'https://api.moonshot.cn./v1'},
  {url:'https://generativelanguage.googleapis.com',type:' openai-compatible '},
  {url:'https://custom.example.invalid',type:'\ufeffGEMINI\ufeff'},
  {url:'https://api.moonshot.cn',type:'unknown'},
  {url:'not a URL'},
  {url:'//api.moonshot.cn/v1'},
  {url:'https://example.invalid',type:'\u0085gemini'},
];
process.stdout.write(JSON.stringify(cases.map(c => ({...c,expected:resolveProviderType(c)}))));
