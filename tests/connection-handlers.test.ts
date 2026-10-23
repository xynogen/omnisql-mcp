import { describe, it, expect } from 'bun:test';
import { ErrorCode, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { OmniSQLMCPServer } from '../src/server.js';
import { AccessPolicy } from '../src/policy/access.js';

function fixture() {
  const connection = {
    id: 'fixture',
    name: 'Fixture',
    driver: 'postgres',
    url: '',
    database: 'app',
  };
  const lookups: unknown[][] = [];
  const server = Object.assign(Object.create(OmniSQLMCPServer.prototype), {
    configParser: {
      getConnection: async (...args: unknown[]) => {
        lookups.push(args);
        return connection;
      },
    },
    accessPolicy: new AccessPolicy(),
    allowedConnections: null,
    readOnly: false,
    disabledTools: [],
    log: () => {},
  });
  return { server, connection, lookups };
}
const writes = [
  ['handleWriteQuery', { query: 'INSERT INTO orders VALUES (1)' }],
  ['handleCreateTable', { query: 'CREATE TABLE orders(id INTEGER)' }],
  ['handleAlterTable', { query: 'ALTER TABLE orders ADD id INTEGER' }],
  ['handleDropTable', { tableName: 'orders', confirm: true }],
  ['handleBeginTransaction', {}],
] as const;

describe('required connection handlers', () => {
  it('preserves sanitizing, names, and database overrides', async () => {
    const { server, connection, lookups } = fixture();
    expect(await server.requireConnection(' Fixture ', 'reporting')).toBe(connection);
    expect(lookups).toEqual([[' Fixture ', 'reporting']]);
  });
  it.each([false, true])(
    'does not distinguish missing and whitelist-hidden connections (%s)',
    async (hidden) => {
      const { server } = fixture();
      if (hidden) server.allowedConnections = new Set(['other']);
      else server.configParser.getConnection = async () => null;
      await expect(server.requireConnection('fixture')).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
        message: expect.stringContaining('Connection not found: fixture'),
      });
    }
  );
  it('keeps connection policy enforcement inside resolution', async () => {
    const { server } = fixture();
    server.accessPolicy.assertConnection = () => {
      throw new Error('policy denied');
    };
    await expect(server.requireConnection('fixture')).rejects.toThrow('policy denied');
  });
  it.each(writes)('blocks per-connection read-only writes through %s', async (handler, args) => {
    const { server } = fixture();
    server.accessPolicy.isReadOnly = () => true;
    await expect(server[handler]({ connectionId: 'fixture', ...args })).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
    });
  });
  it.each([
    ['handleExecuteQuery', 'DELETE FROM orders WHERE id=1'],
    ['handleExportData', 'DELETE FROM orders WHERE id=1'],
    ['handleWriteQuery', 'SELECT 1'],
    ['handleCreateTable', 'SELECT 1'],
    ['handleAlterTable', 'SELECT 1'],
    ['handleExplainQuery', 'DELETE FROM orders WHERE id=1'],
  ])('validates SQL before lookup through %s', async (handler, query) => {
    const { server, lookups } = fixture();
    await expect(server[handler]({ connectionId: 'fixture', query })).rejects.toThrow();
    expect(lookups).toEqual([]);
  });
  it('preserves read and write response contracts', async () => {
    const { server } = fixture();
    server.workspaceClient = {
      testConnection: async () => ({ success: true }),
      executeQuery: async () => ({ executionTime: 5, affectedRows: 1 }),
    };
    expect(await server.handleTestConnection({ connectionId: 'fixture' })).toEqual({
      content: [
        { type: 'text', text: JSON.stringify({ success: true, connectionId: 'fixture' }, null, 2) },
      ],
    });
    expect(
      await server.handleWriteQuery({
        connectionId: 'fixture',
        query: 'INSERT INTO orders VALUES (1)',
      })
    ).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              query: 'INSERT INTO orders VALUES (1)',
              connection: 'Fixture',
              executionTime: 5,
              affectedRows: 1,
              success: true,
            },
            null,
            2
          ),
        },
      ],
    });
  });
  it('passes database and compression options through dispatch unchanged', async () => {
    const { server } = fixture();
    let dispatch: any;
    server.server = {
      setRequestHandler: (schema: unknown, handler: unknown) => {
        if (schema === CallToolRequestSchema) dispatch = handler;
      },
    };
    const args = {
      connectionId: 'fixture',
      database: 'reporting',
      query: 'SELECT 1',
      compression: 'gzip',
    };
    server.handleExportData = async (received: unknown) => {
      expect(received).toEqual(args);
      return { content: [{ type: 'text', text: 'unchanged' }] };
    };
    server.setupToolHandlers();
    expect(await dispatch({ params: { name: 'export_data', arguments: args } })).toEqual({
      content: [{ type: 'text', text: 'unchanged' }],
    });
  });
  it('blocks all transaction/write tools at dispatch in global read-only mode', async () => {
    const { server } = fixture();
    let dispatch: any;
    server.readOnly = true;
    server.server = {
      setRequestHandler: (schema: unknown, handler: unknown) => {
        if (schema === CallToolRequestSchema) dispatch = handler;
      },
    };
    server.setupToolHandlers();
    for (const [name, args] of [
      ['write_query', { connectionId: 'fixture', query: 'INSERT INTO orders VALUES (1)' }],
      ['create_table', { connectionId: 'fixture', query: 'CREATE TABLE orders(id INT)' }],
      ['alter_table', { connectionId: 'fixture', query: 'ALTER TABLE orders ADD id INT' }],
      ['drop_table', { connectionId: 'fixture', tableName: 'orders', confirm: true }],
      ['begin_transaction', { connectionId: 'fixture' }],
      ['commit_transaction', { transactionId: 'fixture' }],
      ['rollback_transaction', { transactionId: 'fixture' }],
      ['execute_in_transaction', { transactionId: 'fixture', query: 'SELECT 1' }],
    ])
      await expect(dispatch({ params: { name, arguments: args } })).rejects.toMatchObject({
        code: ErrorCode.InvalidRequest,
      });
  });
});
