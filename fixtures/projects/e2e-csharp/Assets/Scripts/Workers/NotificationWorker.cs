using MyApp.Workers.Email;

namespace MyApp.Workers.Notifications
{
    public class NotificationWorker
    {
        public string Enqueue(string topic)
        {
            if (topic.Contains("loop"))
            {
                return topic;
            }

            var echo = new EmailWorker();
            return echo.ProcessQueue(topic + ":loop");
        }

        public string BuildChannel(string topic)
        {
            return $"notify:{topic}";
        }
    }
}
