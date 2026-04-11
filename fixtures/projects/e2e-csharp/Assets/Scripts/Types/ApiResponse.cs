using MyApp.Constants;

namespace MyApp.Types
{
    public class ApiResponse
    {
        public bool Success { get; }
        public string Message { get; }
        public int StatusCode { get; }

        public ApiResponse(bool success, string message, int statusCode)
        {
            Success = success;
            Message = message;
            StatusCode = statusCode;
        }

        public bool IsOk()
        {
            return Success && HttpConstants.IsSuccess(StatusCode);
        }
    }
}
