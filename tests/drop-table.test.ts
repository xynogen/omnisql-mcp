import { describe, it, expect } from 'bun:test';
import { OmniSQLMCPServer } from '../src/server.js';
import { AccessPolicy } from '../src/policy/access.js';

// Bypass constructor side effects; exercise the actual handler and normal policy path.
function fixture(driver = 'sqlite') {
  const checked: string[] = [],
    queries: string[] = [];
  const connection = { id: 'fixture', name: 'fixture', driver, url: '' };
  const server = Object.assign(Object.create(OmniSQLMCPServer.prototype), {
    getConnection: async () => connection,
    accessPolicy: new AccessPolicy(),
    workspaceClient: {
      getTableSchema: async (_: unknown, name: string) => {
        checked.push(name);
      },
      executeQuery: async (_: unknown, query: string, options?: unknown) => {
        expect(options).toBeUndefined();
        queries.push(query);
        return { executionTime: 0 };
      },
    },
  });
  return { server, checked, queries, connection };
}

describe('drop_table targeting', () => {
  it.each([
    ['postgresql', 'public.Orders', '"public"."Orders"'],
    ['mysql', 'warehouse.orders', '`warehouse`.`orders`'],
    ['mariadb', 'orders', '`orders`'],
    ['sqlserver', 'dbo.orders', '[dbo].[orders]'],
    ['sqlite', 'main.orders', '"main"."orders"'],
    ['oracle', 'HR.ORDERS', '"HR"."ORDERS"'],
    ['oracle', 'hr.orders', '"hr"."orders"'],
    ['duckdb', 'main.orders', '"main"."orders"'],
    ['clickhouse', 'reports.orders', '`reports`.`orders`'],
    ['postgresql', '"sales.region"."Order Items"', '"sales.region"."Order Items"'],
    ['mysql', '`sales`.`order-items`', '`sales`.`order-items`'],
    ['sqlserver', '[dbo].[Order Items]', '[dbo].[Order Items]'],
    ['sqlite', '"a.b"', '"a.b"'],
    ['sqlite', '"a""b"', '"a""b"'],
    ['sqlite', '"orders; DROP TABLE secrets"', '"orders; DROP TABLE secrets"'],
  ])('uses %s quoting for the exact metadata target %s', async (driver, tableName, sql) => {
    const { server, checked, queries } = fixture(driver);
    await server.handleDropTable({ connectionId: 'fixture', tableName, confirm: true });
    expect(checked).toEqual([tableName]);
    expect(queries).toEqual(['DROP TABLE ' + sql]);
  });
  it('requires confirmation without accessing the database', async () => {
    const { server, checked, queries } = fixture();
    const response = await server.handleDropTable({
      connectionId: 'fixture',
      tableName: 'orders',
      confirm: false,
    });
    expect(JSON.parse(response.content[0].text).success).toBe(false);
    expect(checked).toEqual([]);
    expect(queries).toEqual([]);
  });
  it.each(['a..b', 'a.b.c', '"unterminated', '[unterminated', '"a"b', '"a".b.c', 'orders\\x', ''])(
    'rejects unsupported or unsafe name %s',
    async (tableName) => {
      const { server, queries } = fixture();
      await expect(
        server.handleDropTable({ connectionId: 'fixture', tableName, confirm: true })
      ).rejects.toThrow();
      expect(queries).toEqual([]);
    }
  );
  it('does not drop a different SQLite schema from the metadata check', async () => {
    const { server, queries } = fixture();
    await expect(
      server.handleDropTable({ connectionId: 'fixture', tableName: 'temp.orders', confirm: true })
    ).rejects.toThrow();
    expect(queries).toEqual([]);
  });
  it('does not execute after a failed existence/access check', async () => {
    const { server, queries } = fixture();
    server.workspaceClient.getTableSchema = async () => {
      throw new Error('denied');
    };
    await expect(
      server.handleDropTable({ connectionId: 'fixture', tableName: 'orders', confirm: true })
    ).rejects.toThrow('does not exist or cannot be accessed');
    expect(queries).toEqual([]);
  });
  it('retains per-connection read-only checks', async () => {
    const { server, queries } = fixture();
    server.accessPolicy.isReadOnly = () => true;
    await expect(
      server.handleDropTable({ connectionId: 'fixture', tableName: 'orders', confirm: true })
    ).rejects.toThrow('read-only');
    expect(queries).toEqual([]);
  });
});
