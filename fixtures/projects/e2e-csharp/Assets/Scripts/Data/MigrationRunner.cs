namespace MyApp.Data
{
    public class MigrationRunner
    {
        private readonly DatabaseConnection connection;

        public MigrationRunner(DatabaseConnection connection)
        {
            this.connection = connection;
        }

        public bool RunPending()
        {
            return connection.Open();
        }

        public string BuildMigrationName(int version)
        {
            return $"migration_{version}";
        }
    }
}
