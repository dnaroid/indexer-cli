using UnityEngine;
using MyApp.Types;

namespace MyApp.Config
{
    [CreateAssetMenu(fileName = "AppSettings", menuName = "MyApp/Config/App Settings")]
    public class AppSettings : ScriptableObject
    {
        [SerializeField] private string defaultPlayerId = "engine-admin";
        [SerializeField] private int readyStatusCode = 202;

        public string DefaultPlayerId => defaultPlayerId;
        public int ReadyStatusCode => readyStatusCode;

        public ApiResponse CreateReadyResponse(string message)
        {
            return new ApiResponse(true, message, ReadyStatusCode);
        }
    }
}
