using MyApp.Constants;
using MyApp.Helpers;
using MyApp.Types;

namespace MyApp.Middleware
{
    public class AuthMiddleware
    {
        public ApiResponse Authorize(string token)
        {
            var normalized = StringHelper.NormalizeSlug(token);
            if (normalized.Length < HttpConstants.BearerTokenMinLength)
            {
                return new ApiResponse(false, "unauthorized", HttpConstants.UnauthorizedStatusCode);
            }

            return new ApiResponse(true, "authorized", HttpConstants.OkStatusCode);
        }

        public string BuildHeader(string token)
        {
            return $"Bearer {token}";
        }
    }
}
