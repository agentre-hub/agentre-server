import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-2">
        <h1 className="text-4xl font-bold">404</h1>
        <p className="text-muted-foreground">页面不存在</p>
        <Link to="/" className="underline">回到首页</Link>
      </div>
    </div>
  );
}
