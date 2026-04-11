using MyApp.Combat;
using MyApp.Multiplayer;
using MyApp.Payments;
using MyApp.Services;
using MyApp.Types;
using UnityEngine;

namespace MyApp.Game
{
    public class GameManager : MonoBehaviour
    {
        private CombatManager combatManager;
        private Session session;
        private readonly PlayerService playerService = new PlayerService();
        private readonly StripeProcessor processor = new StripeProcessor();

        public void Awake()
        {
            combatManager = GetComponent<CombatManager>();
            session = GetComponent<Session>();
            playerService.ValidatePlayer("game-manager");
        }

        public void Start()
        {
            var response = BootGame();
            Debug.Log(response.Message);
        }

        public ApiResponse BootGame()
        {
            var sessionResponse = session != null ? session.Open() : new ApiResponse(false, "offline", 503);
            var paymentResponse = processor.ProcessPayment("boot-order", 499);
            var combatReady = combatManager == null || combatManager.ResolveCombatTick();
            var ok = sessionResponse.Success && paymentResponse.Success && combatReady;
            return new ApiResponse(ok, ok ? "booted" : "failed", ok ? 200 : 500);
        }
    }
}
