import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiagnosticTask } from '../../src/shared/arthas';

export async function writeSourceFixture(root: string): Promise<void> {
  const java = join(root, 'module/src/main/java/com/example');
  const xml = join(root, 'module/src/main/resources/mapper');
  await mkdir(java, { recursive: true });
  await mkdir(xml, { recursive: true });
  await writeFile(
    join(java, 'CatalogService.java'),
    `package com.example;
import java.util.List;
public class CatalogService {
 private OrderAssembler assembler;
 public String query(String input) { return assembler.doAssemble(input); }
}
`,
  );
  await writeFile(
    join(java, 'OrderAssembler.java'),
    `package com.example;
import com.example.OrderMapper;
public class OrderAssembler {
 private OrderMapper orderMapper;
 public String doAssemble(String input) { return fillGoodsList(input); }
 private String fillGoodsList(String input) {
   String note = "fakeMethod() { not Java code; }";
   return orderMapper.selectGoods(input);
 }
}
`,
  );
  await writeFile(
    join(java, 'OrderMapper.java'),
    `package com.example;
public interface OrderMapper {
 String selectGoods(String orderId);
}
`,
  );
  await writeFile(
    join(xml, 'OrderMapper.xml'),
    `<mapper namespace="com.example.OrderMapper">
 <sql id="columns">order_id, goods_name</sql>
 <select id="selectGoods" resultType="string">SELECT <include refid="columns"/> FROM order_goods WHERE order_id = #{orderId}</select>
</mapper>`,
  );
  await writeFile(join(root, 'application.yml'), 'password: NEVER_SEND_CONFIGURATION');
}

export function sourceTask(): DiagnosticTask {
  return {
    id: 'diagnosis',
    agentId: 'agent',
    command: 'watch entry',
    status: 'ended',
    results: [],
    jvm: {
      projectId: 'alpha',
      environmentId: 'env',
      serviceId: 'service',
      instanceId: 'instance',
      serverId: 'server',
      connectionId: 'connection',
      containerName: 'container',
      containerId: 'a'.repeat(64),
      startedAt: 'start',
      pid: 7,
      uid: '0',
      startTicks: '1',
      java: '/usr/bin/java',
    },
    deep: {
      entryClass: 'com.example.CatalogService',
      entryMethod: 'query',
      phase: 'complete',
      samples: 5,
      skipped: 0,
      intervalMs: 1000,
      durationMs: 45000,
      paths: [
        {
          id: 'path',
          hits: 5,
          state: 'RUNNABLE',
          frames: [
            { className: 'java.net.SocketInputStream', methodName: 'socketRead0' },
            { className: 'com.mysql.cj.protocol.a.NativeProtocol', methodName: 'readMessage' },
            {
              className: 'com.example.OrderMapper',
              methodName: 'selectGoods',
              fileName: 'OrderMapper.java',
              lineNumber: 3,
            },
            {
              className: 'com.example.OrderAssembler',
              methodName: 'fillGoodsList',
              fileName: 'OrderAssembler.java',
              lineNumber: 8,
            },
            {
              className: 'com.example.OrderAssembler',
              methodName: 'doAssemble',
              fileName: 'OrderAssembler.java',
              lineNumber: 5,
            },
            {
              className: 'com.example.CatalogService',
              methodName: 'query',
              fileName: 'CatalogService.java',
              lineNumber: 5,
            },
          ],
        },
      ],
    },
  };
}

export async function createModelFixture() {
  const state = {
    mode: 'normal' as 'normal' | 'invalid-reference' | 'invalid-json' | 'error' | 'hold',
    requests: [] as { headers: Record<string, unknown>; body: Record<string, any> }[],
    release: undefined as (() => void) | undefined,
  };
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    state.requests.push({ headers: request.headers, body });
    if (state.mode === 'error') {
      response.writeHead(401);
      response.end('MODEL_MUST_NOT_ECHO_KEY');
      return;
    }
    if (state.mode === 'hold')
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
    response.setHeader('Content-Type', 'application/json');
    if (body.messages.length === 1) {
      response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
      return;
    }
    const prompt = JSON.parse(body.messages[1].content);
    const id =
      state.mode === 'invalid-reference'
        ? 'NOT_SENT'
        : (prompt.sources.find((source: any) => source.kind === 'sql')?.id ?? prompt.sources[0].id);
    const content =
      state.mode === 'invalid-json'
        ? 'not-json'
        : JSON.stringify({
            summary: '源码使用明确的商品查询，等待数据库返回的原因仍需执行计划验证。',
            findings: [
              {
                title: '商品查询等待数据库返回',
                conclusion:
                  '关联源码定位到OrderMapper.selectGoods及调用方fillGoodsList；当前证据不能证明缺索引。',
                evidenceLevel: 'needs-verification',
                evidenceIds: [id],
                suggestions: [
                  '检查这个Mapper SQL的执行计划和实际扫描行数，再决定索引或查询改写方案。',
                ],
              },
            ],
            checks: ['核对数据库锁等待与网络响应。'],
          });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Invalid model fixture address');
  return {
    state,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      state.release?.();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
