//! PostgreSQL access: sessions (connections, TLS, read-only, timeouts, cancellation), statement
//! execution with row caps, introspection for the explorer, and DDL generation.

pub mod ddl;
pub mod introspect;
pub mod query;
pub mod session;

#[cfg(test)]
mod integration_tests;
