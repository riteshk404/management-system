/**
 * Direct MongoDB connection has been removed per tenant isolation architecture.
 * All authentication, device authorization, and session management are handled
 * exclusively via the Management Console HTTP API.
 */
module.exports = {
  connect: async () => { throw new Error('Direct database connection is disabled.'); },
  disconnect: async () => {},
  isConnected: () => false
};
