using UnityEngine;
using MyApp.Core;

namespace MyApp.Network
{
    public class NetworkClient : MonoBehaviour
    {
        [SerializeField] private EngineManager engineManager;

        public void Awake()
        {
            if (engineManager == null)
            {
                engineManager = FindFirstObjectByType<EngineManager>();
            }
        }

        public void Start()
        {
            Debug.Log($"Connecting from {gameObject.name}");
        }

        public void Update()
        {
            if (transform.hasChanged)
            {
                transform.hasChanged = false;
            }
        }

        public void Connect()
        {
            if (engineManager == null)
            {
                Debug.Log("EngineManager missing");
                return;
            }

            var response = engineManager.StartEngine();
            Debug.Log(response.Message);
        }

        public void OnDestroy()
        {
            engineManager = null;
        }
    }
}
