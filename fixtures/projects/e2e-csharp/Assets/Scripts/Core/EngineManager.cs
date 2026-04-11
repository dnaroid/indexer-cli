using UnityEngine;
using MyApp.Services;
using MyApp.Config;
using MyApp.Types;

namespace MyApp.Core
{
    public class EngineManager : MonoBehaviour
    {
        public static EngineManager Instance { get; private set; }

        [SerializeField] private AppSettings appSettings;
        [SerializeField] private Transform targetRoot;
        [SerializeField] private string bootstrapPlayerId = "engine-admin";

        private readonly PlayerService playerService = new PlayerService();

        public void Awake()
        {
            if (Instance != null && Instance != this)
            {
                Destroy(gameObject);
                return;
            }

            Instance = this;
            targetRoot = transform;
        }

        public void Start()
        {
            var response = StartEngine();
            Debug.Log(response.Message);
        }

        public void Update()
        {
            if (targetRoot != null)
            {
                targetRoot.hasChanged = false;
            }
        }

        public ApiResponse StartEngine()
        {
            var settings = appSettings != null ? appSettings : ScriptableObject.CreateInstance<AppSettings>();
            var playerId = string.IsNullOrWhiteSpace(bootstrapPlayerId) ? settings.DefaultPlayerId : bootstrapPlayerId;
            var displayName = playerService.FormatDisplayName(playerId);
            return settings.CreateReadyResponse(displayName);
        }

        public void OnDestroy()
        {
            if (Instance == this)
            {
                Instance = null;
            }
        }
    }
}
