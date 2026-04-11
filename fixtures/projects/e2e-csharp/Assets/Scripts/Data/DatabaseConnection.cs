using MyApp.Constants;

namespace MyApp.Data
{
    public class DatabaseConnection
    {
        public string ConnectionString { get; private set; }

        public DatabaseConnection(string databaseName)
        {
            ConnectionString = $"Data Source={GameConstants.BuildSceneKey(databaseName)}.db";
        }

        public bool Open()
        {
            return ConnectionString.Length > 10;
        }
    }
}
