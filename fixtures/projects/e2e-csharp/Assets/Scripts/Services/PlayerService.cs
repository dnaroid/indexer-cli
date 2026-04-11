using MyApp.Helpers;
using MyApp.Utils;

namespace MyApp.Services
{
    public class PlayerService
    {
        public bool ValidatePlayer(string playerId)
        {
            if (string.IsNullOrWhiteSpace(playerId))
            {
                ErrorHandler.ThrowValidationError("playerId", "Player id is required");
                return false;
            }

            if (playerId.Length < 4)
            {
                ErrorHandler.ThrowValidationError("playerId", "Player id is too short");
                return false;
            }

            return StringHelper.NormalizeSlug(playerId).Length >= 4;
        }

        public string FormatDisplayName(string playerId)
        {
            return StringHelper.ToTitleCase(playerId.Replace("-", " "));
        }
    }
}
