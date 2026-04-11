namespace MyApp.Constants
{
    public static class GameConstants
    {
        public const int DefaultEnemyCount = 4;
        public const float CombatTickSeconds = 0.5f;
        public const float NetworkHeartbeatSeconds = 1.5f;
        public const int InventoryCapacity = 24;

        public static string BuildSceneKey(string sceneName)
        {
            return $"scene:{sceneName.ToLowerInvariant()}";
        }
    }
}
