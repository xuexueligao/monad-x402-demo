'use client';

import { useParams } from 'next/navigation';
import { ChallengeResultView } from '@/components/challenge-result';

export default function ResultPage() {
  const { id } = useParams<{ id: string }>();
  return <ChallengeResultView challengeId={id} />;
}
