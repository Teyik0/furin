// Each isolated test worker gets its own database instead of contending on
// the application's persistent file.
process.env.TASK_MANAGER_DB_PATH = ":memory:";
