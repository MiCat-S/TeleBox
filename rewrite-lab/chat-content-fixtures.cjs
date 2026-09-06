const {loadBindings} = require('./source-harness.cjs');
const {aggregateOpenAIResponses} = loadBindings('../TeleBox-Plugins/ai/ai.ts', [
  'parseOpenAIChatResponse', 'collectOpenAISources', 'aggregateOpenAIResponses',
], {parseDataUrl() { throw new Error('media outside text fixture'); }});
const contents = ['  hello  ', '<你好>&', {type:'text', text:'one'},
  [{type:'text', text:'one'}, {type:'output_text', text:'two'}],
  [{type:'text', text:'  one\n'}, {type:'text', text:'two  '}],
  [{type:'text', text:'😀'}], {type:'output_text',text:'\ufeffhi\ufeff'}];
const cases = contents.map(content => ({content, text:aggregateOpenAIResponses([{choices:[{message:{content}}]}]).text}));
process.stdout.write(JSON.stringify(cases));
