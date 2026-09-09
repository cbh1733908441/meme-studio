import test from 'node:test';
import assert from 'node:assert/strict';
import {eventMessage} from '../lib/runner.mjs';

test('connection retries and terminal errors are visible without leaking tokens',()=>{
 assert.equal(eventMessage({type:'error',message:'Reconnecting... 3/5 (stream disconnected before completion: tls handshake eof)'}),'Codex 连接中断，正在重连（3/5）');
 const failure=eventMessage({type:'turn.failed',error:{message:'request failed Bearer abc123 sk-secretExample'}});
 assert.match(failure,/执行异常/);assert.ok(!failure.includes('abc123'));assert.ok(!failure.includes('secretExample'));
 assert.equal(eventMessage({type:'item.completed',item:{type:'agent_message',text:'{"meme":"测试"}'}}),undefined);
});
