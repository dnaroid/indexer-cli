using MyApp.Constants;
using MyApp.Types;
using UnityEngine;

namespace MyApp.Multiplayer
{
    public class Session : MonoBehaviour
    {
        private string sessionCode;
        private float heartbeatTimer;

        public void Awake()
        {
            sessionCode = "LOBBY-001";
            heartbeatTimer = 0f;
        }

        public void Update()
        {
            heartbeatTimer += Time.deltaTime;
            if (heartbeatTimer >= GameConstants.NetworkHeartbeatSeconds)
            {
                heartbeatTimer = 0f;
            }
        }

        public ApiResponse Open()
        {
            return new ApiResponse(true, sessionCode, HttpConstants.OkStatusCode);
        }
    }
}
