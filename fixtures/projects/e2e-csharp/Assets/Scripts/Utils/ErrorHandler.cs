using System;

namespace MyApp.Utils
{
    public static class ErrorHandler
    {
        public static void ThrowValidationError(string field, string message)
        {
            throw new ValidationError(field, message);
        }

        public static Exception BuildNetworkError(string endpoint)
        {
            return new NetworkError($"Network request failed for {endpoint}");
        }
    }

    public class ValidationError : Exception
    {
        public ValidationError(string field, string message) : base($"{field}:{message}")
        {
        }
    }

    public class NetworkError : Exception
    {
        public NetworkError(string message) : base(message)
        {
        }
    }
}
