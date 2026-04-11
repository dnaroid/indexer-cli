using UnityEngine;

namespace MyApp.Game
{
    [CreateAssetMenu(fileName = "PlayerModel", menuName = "MyApp/Game/Player Model")]
    public class PlayerModel : ScriptableObject
    {
        [SerializeField] private string playerId = "player-one";

        public string PlayerId => playerId;
    }
}
