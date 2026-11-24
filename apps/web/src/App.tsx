import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Library } from "./pages/Library";
import { MovieDetail } from "./pages/MovieDetail";
import { Theater } from "./pages/Theater";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Library />} />
        <Route path="/movie/:id" element={<MovieDetail />} />
      </Route>
      {/* Theater mode takes the whole screen, so it renders outside the layout. */}
      <Route path="/theater/:id" element={<Theater />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
