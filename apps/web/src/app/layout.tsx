export const metadata = {
  title: 'Распил Пак',
  description: 'Telegram bot for creating emoji packs',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}

