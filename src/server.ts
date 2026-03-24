import express, { Request, Response } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import { supabase } from './supabaseClient';
import Filter from 'bad-words';

const filter = new Filter();
dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

app.get('/api/health', (req: Request, res: Response) => res.status(200).json({ status: 'API is running.' }));
app.get('/api/bars', async (req: Request, res: Response) => {
  const { data, error } = await supabase.from('bars').select('*');
  res.status(200).json({ status: 'success', data });
});

const activeGames: Record<string, boolean> = {}; 
const activeQuestions: Record<string, { gameId: string, correctAnswer: string, startedAt: number }> = {};

app.post('/api/games/start', async (req: Request, res: Response): Promise<any> => {
  try {
    // NEW: Catch the prize from the request!
    const { barId, category, prize } = req.body;

    if (activeGames[barId]) {
      return res.status(400).json({ message: 'A game is already in progress!' });
    }
    activeGames[barId] = true; 

    const { data: allQuestions, error: fetchError } = await supabase.from('questions').select('*');
    if (fetchError) console.error("DB Error:", fetchError);

    if (!allQuestions || allQuestions.length < 3) {
      delete activeGames[barId];
      return res.status(400).json({ message: 'Not enough questions! Need at least 3.' });
    }

    const questions = allQuestions.sort(() => 0.5 - Math.random()).slice(0, 3);

    const { data: liveGame, error: gameError } = await supabase
      .from('live_games')
      .insert({ bar_id: barId, status: 'in_progress' })
      .select().single();

    if (gameError) throw gameError;

    res.status(200).json({ status: 'Game loop started!' });

    (async () => {
      let finalLeaderboard: any[] = []; 

      for (let i = 0; i < questions.length; i++) {
        const selectedQuestion = questions[i];
        const allAnswers = [selectedQuestion.correct_answer, ...selectedQuestion.wrong_answers].sort(() => Math.random() - 0.5);

        console.log(`\n🎬 Starting Question ${i + 1} of 3`);

        activeQuestions[barId] = { 
          gameId: liveGame.id, 
          correctAnswer: selectedQuestion.correct_answer, 
          startedAt: Date.now() 
        };

        io.to(barId).emit('NEW_QUESTION', {
          questionText: selectedQuestion.question_text,
          answers: allAnswers,
          timer: 10
        });

        await sleep(11000);

        console.log('📊 Question over! Tallying leaderboard...');
        
        const { data: scores } = await supabase.from('player_scores').select('player_name, score').eq('game_id', liveGame.id);

        let leaderboard: any[] = [];
        if (scores && scores.length > 0) {
          const aggregatedScores: Record<string, number> = {};
          scores.forEach(row => {
            aggregatedScores[row.player_name] = (aggregatedScores[row.player_name] || 0) + row.score;
          });

          leaderboard = Object.entries(aggregatedScores)
            .map(([name, score]) => ({ name, score }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);
          finalLeaderboard = leaderboard; 
        }

        // THE UPGRADE: Send the leaderboard AND the correct answer!
        io.to(barId).emit('SHOW_LEADERBOARD', {
          leaderboard: leaderboard,
          correctAnswer: selectedQuestion.correct_answer
        });

        delete activeQuestions[barId];

        if (i < questions.length - 1) {
          console.log('⏳ Waiting 8 seconds before next question...');
          await sleep(8000);
        }
      }

     console.log('\n🏁 GAME OVER! All questions finished.');
      await supabase.from('live_games').update({ status: 'completed' }).eq('id', liveGame.id);
      
      console.log('⏳ Displaying final results for 8 seconds...');
      await sleep(8000);

      // THE UPGRADE: We now send an object containing both the leaderboard and the prize!
      io.to(barId).emit('GAME_OVER', {
        leaderboard: finalLeaderboard,
        prize: prize || 'Bragging Rights'
      });

      delete activeGames[barId]; 

    })(); // <-- This executes the async loop
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});



io.on('connection', (socket) => {
  socket.on('join_bar', (data) => {
    const barId = typeof data === 'string' ? data : data.barId;
    const nickname = data.nickname;
    if (nickname && filter.isProfane(nickname)) return socket.emit('JOIN_ERROR', 'Keep it clean! Please pick another name.');
    socket.join(barId);
    socket.emit('JOIN_SUCCESS');
  });

  socket.on('SUBMIT_ANSWER', async (data) => {
    const { barId, nickname, answer } = data;
    const activeQ = activeQuestions[barId];

    if (!activeQ) return; 
    const timeElapsed = Date.now() - activeQ.startedAt;
    if (timeElapsed > 11000) return; 

    if (answer === activeQ.correctAnswer) {
      const timePenalty = Math.floor((timeElapsed / 10000) * 900);
      const pointsEarned = 1000 - timePenalty;

      await supabase.from('player_scores').insert({ game_id: activeQ.gameId, player_name: nickname, score: pointsEarned });
      console.log(`💾 Saved ${pointsEarned} points for ${nickname}`);
    }
  });
});

httpServer.listen(port, () => console.log(`🚀 Trivia API is running on http://localhost:${port}`));