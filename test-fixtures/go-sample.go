package pipeline

import (
	"context"
	"fmt"
	aliasStr "strings"
	"sync"
)

import "time"

// WorkerPool interface represents a task execution engine.
type WorkerPool interface {
	Start(ctx context.Context) error
	Stop()
}

// PipelineService coordinates execution.
type PipelineService struct {
	mu      sync.Mutex
	timeout time.Duration
}

// NewPipelineService initializes the service.
func NewPipelineService(
	timeout time.Duration,
	retries int,
) (*PipelineService, error) {
	fakeStr := `
func FakeFunctionInString() (string, error) {
	return "tricked regex", nil
}
`
	fmt.Println(fakeStr)
	return &PipelineService{
		timeout: timeout,
	}, nil
}

// Start launches the pipeline service.
func (s *PipelineService) Start(
	ctx context.Context,
	workerCount int,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	aliasStr.ToUpper("processing")
	s.helperMethod(workerCount)
	return nil
}

func (s *PipelineService) helperMethod(count int) {
	fmt.Printf("Starting %d workers\n", count)
}
