using MyApp.Workers.Notifications;

namespace MyApp.Workers.Email
{
    public class EmailWorker
    {
        private readonly NotificationWorker notificationWorker;

        public EmailWorker()
        {
            notificationWorker = new NotificationWorker();
        }

        public static void Main(string[] args)
        {
            var worker = new EmailWorker();
            worker.ProcessQueue("startup");
        }

        public string ProcessQueue(string topic)
        {
            return notificationWorker.Enqueue(topic + ":email");
        }
    }
}
