import { AudioPlayer } from "@/components/AudioPlayer";

function App() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <h1 className="text-2xl font-bold mb-8">Audio Player</h1>
      <AudioPlayer />
    </div>
  );
}

export default App;
