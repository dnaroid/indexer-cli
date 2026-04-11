using MyApp.Helpers;
using MyApp.Utils;

namespace MyApp.Services
{
    public class InventoryService
    {
        public bool ValidateItem(string itemId)
        {
            if (string.IsNullOrWhiteSpace(itemId))
            {
                ErrorHandler.ThrowValidationError("itemId", "Item id is required");
                return false;
            }

            if (itemId.Length < 3)
            {
                ErrorHandler.ThrowValidationError("itemId", "Item id is too short");
                return false;
            }

            return StringHelper.NormalizeSlug(itemId).Contains("-");
        }

        public string BuildSlotKey(string itemId)
        {
            return $"slot:{StringHelper.NormalizeSlug(itemId)}";
        }
    }
}
