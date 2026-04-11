using MyApp.Types;

namespace MyApp.API.V2
{
    public class Handler
    {
        public ApiResponse HandleRequest(string route)
        {
            if (route == "/status")
            {
                return new ApiResponse(true, "v2-online", 200);
            }

            return new ApiResponse(false, "v2-missing", 404);
        }

        public string VersionTag()
        {
            return "v2";
        }
    }
}
