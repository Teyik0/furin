// Native and hot-reloaded modules share one named in-memory database per worker.
process.env.TASK_MANAGER_DB_PATH = `file:task-manager-test-${crypto.randomUUID()}?mode=memory&cache=shared`;
