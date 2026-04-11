using MyApp.Constants;
using MyApp.Helpers;
using MyApp.Services;
using UnityEngine;

namespace MyApp.Combat
{
    public class CombatManager : MonoBehaviour
    {
        private PlayerService playerService;
        private float elapsed;
        private int activeTargets;

        public void Awake()
        {
            playerService = new PlayerService();
            activeTargets = GameConstants.DefaultEnemyCount;
            elapsed = 0f;
        }

        public void Update()
        {
            elapsed += Time.deltaTime;
            if (elapsed < GameConstants.CombatTickSeconds)
            {
                return;
            }

            elapsed = 0f;
            ResolveCombatTick();
        }

        public bool ResolveCombatTick()
        {
            var score = MathHelper.Clamp(activeTargets * 2, 1, 99);
            return playerService.ValidatePlayer("arena-player") && score > 0;
        }
    }
}
