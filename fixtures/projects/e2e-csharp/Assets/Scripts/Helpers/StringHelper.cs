using System;

namespace MyApp.Helpers
{
    public static class StringHelper
    {
        public static string NormalizeSlug(string value)
        {
            return value.Trim().ToLowerInvariant().Replace(" ", "-");
        }

        public static string ToTitleCase(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return string.Empty;
            }

            return char.ToUpperInvariant(value[0]) + value.Substring(1).ToLowerInvariant();
        }
    }
}
