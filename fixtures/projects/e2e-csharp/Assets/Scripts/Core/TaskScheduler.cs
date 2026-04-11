using System.Collections;
using MyApp.Game;
using UnityEngine;

namespace MyApp.Core
{
    public class TaskScheduler : MonoBehaviour
    {
        [SerializeField] private EngineManager engineManager;
        [SerializeField] private PlayerModel defaultPlayer;

        private readonly Queue pendingPlayers = new Queue();

        public void Awake()
        {
            if (engineManager == null)
            {
                engineManager = GetComponent<EngineManager>();
            }
        }

        public void Start()
        {
            if (defaultPlayer != null)
            {
                Schedule(defaultPlayer);
            }
        }

        public void Update()
        {
            if (pendingPlayers.Count > 0)
            {
                Debug.Log($"Queued players: {pendingPlayers.Count}");
            }
        }

        public void Schedule(PlayerModel player)
        {
            pendingPlayers.Enqueue(player.PlayerId);
            if (engineManager != null)
            {
                engineManager.StartEngine();
            }
        }

        public void OnDestroy()
        {
            pendingPlayers.Clear();
        }
    }
}
