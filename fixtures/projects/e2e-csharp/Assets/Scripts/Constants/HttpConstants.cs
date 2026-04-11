namespace MyApp.Constants
{
    public static class HttpConstants
    {
        public const int OkStatusCode = 200;
        public const int UnauthorizedStatusCode = 401;
        public const int NotFoundStatusCode = 404;
        public const int BearerTokenMinLength = 12;

        public static bool IsSuccess(int statusCode)
        {
            return statusCode >= 200 && statusCode < 300;
        }
    }
}
