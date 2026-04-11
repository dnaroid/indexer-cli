using MyApp.Types;

namespace MyApp.API.V1
{
    public class Handler
    {
        public ApiResponse HandleRequest(string route)
        {
            if (route == "/status")
            {
                return new ApiResponse(true, "v1-online", 200);
            }

            return new ApiResponse(false, "v1-missing", 404);
        }

        public string VersionTag()
        {
            return "v1";
        }
    }
}
