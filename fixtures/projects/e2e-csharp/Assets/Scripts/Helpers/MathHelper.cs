namespace MyApp.Helpers
{
    public static class MathHelper
    {
        public static int Clamp(int value, int min, int max)
        {
            if (value < min)
            {
                return min;
            }

            if (value > max)
            {
                return max;
            }

            return value;
        }

        public static int Sum(int left, int right)
        {
            return left + right;
        }
    }
}
