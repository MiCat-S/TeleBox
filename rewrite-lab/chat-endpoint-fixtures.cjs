const {loadBindings} = require('./source-harness.cjs');
const modes = {openai:{}, 'openai-compatible':{}, moonshot:{}, doubao:{baseUrlType:'origin',endpoint:'api/v3/chat/completions'},'local-cliproxy':{baseUrlType:'openai'}};
const {resolveBaseUrl, resolveEndpointUrl, applyAuthConfig} = loadBindings('../TeleBox-Plugins/ai/ai.ts',[
  'normalizeOpenAIBaseUrl','resolveBaseUrl','resolveEndpointUrl','applyAuthConfig',
],{URL});
const cases = [
  ['openai','https://example.invalid/v1'],
  ['moonshot','https://api.moonshot.cn/v1/'],
  ['doubao','https://ark.cn-beijing.volces.com/old/path?token=discard'],
  ['local-cliproxy','http://127.0.0.1:8317'],
  ['local-cliproxy','https://example.invalid/api/v1/chat/completions?key=old'],
  ['local-cliproxy','https://gateway.ai.cloudflare.com/v1/account/gateway/openai/chat/completions'],
  ['local-cliproxy','https://example.invalid/prefix/v1/responses'],
  ['local-cliproxy','https://example.invalid/a%2Fb/api/v1/messages'],
  ['openai-compatible','https://example.invalid/v1?mode=test'],
].map(([profile,url])=>{
  const config={url,key:'synthetic +&key'};
  const mode=modes[profile];
  const endpoint=resolveEndpointUrl(resolveBaseUrl(config,mode),mode.endpoint||'chat/completions');
  const result=applyAuthConfig(profile==='local-cliproxy'?'query-key':'bearer',config,endpoint,{});
  return {profile,url,key:config.key,endpoint:result.url,authorization:result.headers.Authorization||''};
});
process.stdout.write(JSON.stringify(cases));
