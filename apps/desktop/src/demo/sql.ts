// Demo data for the SQL scene (demo.html?scene=sql): a MySQL "shop" database on prod-api-01.

const col = (name: string, data_type: string, nullable = false, key: string | null = null, def: string | null = null) => ({
  name,
  data_type,
  nullable,
  default: def,
  key,
});

export const SQL_TREE = {
  database: "shop",
  databases: ["analytics", "shop", "shop_staging"],
  schemas: [
    {
      name: "shop",
      tables: [
        {
          name: "customers",
          kind: "table",
          rows_est: 18240,
          columns: [col("id", "bigint unsigned", false, "PRI"), col("email", "varchar(255)", false, "UNI"), col("name", "varchar(120)"), col("created_at", "timestamp", false, null, "CURRENT_TIMESTAMP")],
          indexes: [
            { name: "PRIMARY", columns: ["id"], unique: true, primary: true },
            { name: "customers_email_unique", columns: ["email"], unique: true, primary: false },
          ],
        },
        {
          name: "orders",
          kind: "table",
          rows_est: 92311,
          columns: [
            col("id", "bigint unsigned", false, "PRI"),
            col("customer_id", "bigint unsigned", false, "MUL"),
            col("status", "enum('new','paid','shipped','refunded')", false, null, "'new'"),
            col("total", "decimal(10,2)"),
            col("paid_at", "timestamp", true),
            col("created_at", "timestamp", false, null, "CURRENT_TIMESTAMP"),
          ],
          indexes: [
            { name: "PRIMARY", columns: ["id"], unique: true, primary: true },
            { name: "orders_customer_id_index", columns: ["customer_id"], unique: false, primary: false },
          ],
        },
        { name: "order_items", kind: "table", rows_est: 251004, columns: [col("id", "bigint unsigned", false, "PRI"), col("order_id", "bigint unsigned", false, "MUL"), col("sku", "varchar(64)"), col("qty", "int")], indexes: [] },
        { name: "products", kind: "table", rows_est: 640, columns: [col("sku", "varchar(64)", false, "PRI"), col("title", "varchar(255)"), col("price", "decimal(10,2)")], indexes: [] },
        { name: "v_daily_sales", kind: "view", rows_est: null, columns: [col("day", "date"), col("orders", "bigint"), col("revenue", "decimal(32,2)")], indexes: [] },
      ],
    },
  ],
};

export const SQL_DRAFT = `-- Orders stuck in "paid" for more than a day
SELECT o.id, c.email, o.status, o.total, o.paid_at
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.status = 'paid'
  AND o.paid_at < NOW() - INTERVAL 1 DAY
ORDER BY o.paid_at
LIMIT 500;
`;

const emails = ["ana.k", "bob", "chen.li", "dmitri", "eva", "farid", "grace", "hana", "ivan", "jules", "kemal", "lena", "mo", "nadia"];

export function sqlRows(): (string | null)[][] {
  return Array.from({ length: 37 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 9, 13, 8 + (i % 9), (i * 17) % 60));
    return [
      String(48210 + i * 7),
      `${emails[i % emails.length]}${i > 13 ? i : ""}@example.com`,
      "paid",
      (19.9 + ((i * 37) % 240) + 0.45).toFixed(2),
      i === 5 ? null : d.toISOString().slice(0, 19).replace("T", " "),
    ];
  });
}

export const SQL_COLUMNS = [
  { name: "id", type_name: "longlong", numeric: true },
  { name: "email", type_name: "var_string", numeric: false },
  { name: "status", type_name: "string", numeric: false },
  { name: "total", type_name: "newdecimal", numeric: true },
  { name: "paid_at", type_name: "timestamp", numeric: false },
];

const conn = (id: string, name: string, engine: "postgres" | "mysql", env: string, extra: Record<string, unknown> = {}) => ({
  id, name, engine, via: "direct", host_id: null, address: "127.0.0.1", port: engine === "mysql" ? 3306 : 5432,
  username: engine === "mysql" ? "root" : "postgres", database: null, ssl_mode: "disable", ca_path: null, env_label: env,
  group_id: null, read_only: false, row_limit: 500, timeout_s: 30, sort: 0, created_at: 1, updated_at: 1, has_password: true, ...extra,
});

export const SQL_CONNS = [
  conn("c-shop", "shop prod", "mysql", "prod", { via: "ssh", host_id: "h-api01", database: "shop" }),
  conn("c-analytics", "analytics", "postgres", "staging", { address: "analytics.db.example.com", ssl_mode: "require", database: "events" }),
  conn("c-local", "laragon mysql", "mysql", "dev", { has_password: false }),
];
