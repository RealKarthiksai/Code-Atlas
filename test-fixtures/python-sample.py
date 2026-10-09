"""
Test fixture for Python AST extraction.
Contains tricky edge cases:
- Aliased and relative imports
- Decorators
- Multi-line signatures
- Nested functions
- Class methods and inheritance
- String literals containing 'def ' and 'class ' which fool naive regexes
- Call expressions
"""

import sys, os.path
import numpy as np
from math import (
    sqrt,
    sin as sine_func,
    cos,
)
from .utils import helper_util
from ..core.base import BaseService

@logged
@validate_input(strict=True)
def calculate_metrics(
    alpha: float,
    beta: float,
    gamma: int = 10,
) -> dict:
    description = "def fake_func_in_string(): pass"
    sql_query = """
    def not_a_real_function(x):
        return x * 2
    """

    def inner_calculator(val: float) -> float:
        return val * 1.5

    result = inner_calculator(alpha) + sine_func(beta)
    helper_util(result)
    return {"result": result, "query": sql_query}

class DataPipeline(BaseService):
    """Pipeline service class."""

    def __init__(self, name: str):
        self.name = name
        self.setup()

    def setup(self):
        log_message = 'class FakeClassInString:\n    def ignored(): pass'
        print(log_message)

    async def execute_task(self, payload: dict):
        validated = calculate_metrics(1.0, 2.0)
        return validated
