// Every module copy in a test worker shares one named in-memory database.
process.env.FURIN_TODO_DATABASE = `file:relay-test-${crypto.randomUUID()}?mode=memory&cache=shared`;
